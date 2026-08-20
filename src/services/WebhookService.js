'use strict';

// Applies a verified Stripe event to our database.
//
// Payment truth lives at Stripe. This database only ever mirrors it, and only
// through events whose signature has already been checked. Nothing here trusts
// the request body on its own.

const { withTransaction } = require('../db/pool');
const tenantRepo = require('../repositories/tenantRepo');
const subscriptionRepo = require('../repositories/subscriptionRepo');
const webhookRepo = require('../repositories/webhookRepo');
const { mapSubscriptionStatus, toDate } = require('./StripeService');

// Claim and apply in ONE transaction. If applying fails, the claim rolls back
// with it, so the event is not marked processed and Stripe's retry can redo it.
// A claim committed separately would silently swallow the event on failure.
async function process(event) {
  return withTransaction(async (client) => {
    const isNew = await webhookRepo.claim(client, event.id, event.type);

    if (!isNew) {
      return { received: true, duplicate: true, applied: null };
    }

    const applied = await apply(client, event);

    return { received: true, duplicate: false, applied };
  });
}

async function apply(client, event) {
  switch (event.type) {
    case 'checkout.session.completed':
      return onCheckoutCompleted(client, event.data.object);

    case 'customer.subscription.updated':
      return onSubscriptionUpdated(client, event.data.object);

    case 'customer.subscription.deleted':
      return onSubscriptionDeleted(client, event.data.object);

    default:
      // Stripe sends far more event types than we care about. Acknowledging the
      // rest with a 200 stops Stripe retrying something we will never handle.
      return `ignored:${event.type}`;
  }
}

async function onCheckoutCompleted(client, session) {
  const tenantId = session.metadata?.tenant_id || session.client_reference_id;

  if (!tenantId) {
    return 'ignored:no tenant reference on session';
  }

  const tenant = await tenantRepo.findById(client, tenantId);

  if (!tenant) {
    return 'ignored:unknown tenant';
  }

  if (session.customer) {
    await tenantRepo.setStripeCustomer(client, tenantId, session.customer);
  }

  await tenantRepo.setPlan(client, tenantId, 'pro', 'active');

  if (session.subscription) {
    await subscriptionRepo.upsert(client, {
      tenantId,
      stripeSubscriptionId: session.subscription,
      status: 'active',
      currentPeriodStart: null,
      currentPeriodEnd: null
    });
  }

  return 'upgraded to pro';
}

async function onSubscriptionUpdated(client, subscription) {
  const tenant = await tenantRepo.findByStripeCustomerId(client, subscription.customer);

  if (!tenant) {
    return 'ignored:unknown customer';
  }

  const status = mapSubscriptionStatus(subscription.status);
  const planCode = status === 'canceled' ? 'free' : tenant.plan_code;

  await tenantRepo.setPlan(client, tenant.id, planCode, status);

  await subscriptionRepo.upsert(client, {
    tenantId: tenant.id,
    stripeSubscriptionId: subscription.id,
    status,
    currentPeriodStart: toDate(subscription.current_period_start),
    currentPeriodEnd: toDate(subscription.current_period_end)
  });

  return `status synced:${status}`;
}

async function onSubscriptionDeleted(client, subscription) {
  const tenant = await tenantRepo.findByStripeCustomerId(client, subscription.customer);

  if (!tenant) {
    return 'ignored:unknown customer';
  }

  await tenantRepo.setPlan(client, tenant.id, 'free', 'canceled');

  await subscriptionRepo.upsert(client, {
    tenantId: tenant.id,
    stripeSubscriptionId: subscription.id,
    status: 'canceled',
    currentPeriodStart: toDate(subscription.current_period_start),
    currentPeriodEnd: toDate(subscription.current_period_end)
  });

  return 'downgraded to free';
}

module.exports = { process };
