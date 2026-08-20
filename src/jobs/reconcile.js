'use strict';

// The background job. Runs on a schedule, off the request path, and exists
// because webhook delivery is not guaranteed.
//
// This is not a theoretical concern. On the first real Checkout of this project
// the `checkout.session.completed` event never arrived: the Stripe CLI's
// websocket dropped and reconnected, and events emitted in the gap were silently
// lost. The customer had paid, Stripe knew, and this database disagreed - and
// nothing in the metering path would ever have noticed.
//
// Two jobs:
//   1. release reservations whose owner died between reserve and commit
//   2. compare every linked tenant against Stripe's view and correct the drift
//
// Stripe is the authority on payment. Where the two disagree, Stripe wins.

const { pool, withTransaction } = require('../db/pool');
const { now } = require('../clock');
const tenantRepo = require('../repositories/tenantRepo');
const subscriptionRepo = require('../repositories/subscriptionRepo');
const reservationRepo = require('../repositories/reservationRepo');
const { mapSubscriptionStatus, toDate } = require('../services/StripeService');

function defaultStripeClient() {
  const Stripe = require('stripe');

  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY must be set in .env');
  }

  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// A crashed process must not hold quota forever. Anything still 'held' past its
// expiry is released so the tenant gets that headroom back.
async function releaseExpiredReservations(at) {
  return withTransaction((client) => reservationRepo.expireStale(client, at));
}

// What Stripe thinks this customer's plan and status are.
async function stripeViewOf(stripeClient, stripeCustomerId) {
  const subscriptions = await stripeClient.subscriptions.list({
    customer: stripeCustomerId,
    status: 'all',
    limit: 10
  });

  const live = subscriptions.data.find(
    (s) => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due'
  );

  if (!live) {
    return { planCode: 'free', status: 'canceled', subscription: null };
  }

  return {
    planCode: mapSubscriptionStatus(live.status) === 'canceled' ? 'free' : 'pro',
    status: mapSubscriptionStatus(live.status),
    subscription: live
  };
}

async function reconcileTenant(stripeClient, tenant) {
  const view = await stripeViewOf(stripeClient, tenant.stripe_customer_id);

  const drifted =
    view.planCode !== tenant.plan_code || view.status !== tenant.subscription_status;

  if (!drifted) {
    return { tenant_id: tenant.id, drifted: false };
  }

  await withTransaction(async (client) => {
    await tenantRepo.setPlan(client, tenant.id, view.planCode, view.status);

    if (view.subscription) {
      await subscriptionRepo.upsert(client, {
        tenantId: tenant.id,
        stripeSubscriptionId: view.subscription.id,
        status: view.status,
        currentPeriodStart: toDate(view.subscription.current_period_start),
        currentPeriodEnd: toDate(view.subscription.current_period_end)
      });
    }
  });

  return {
    tenant_id: tenant.id,
    drifted: true,
    was: { plan: tenant.plan_code, status: tenant.subscription_status },
    now: { plan: view.planCode, status: view.status }
  };
}

// `tenantIds` scopes a run to specific tenants. Operationally that is useful for
// re-checking one customer after an incident; in the tests it is essential,
// because this job is global by nature and an unscoped run would reconcile - and
// rewrite - tenants belonging to every other test file.
async function reconcile({ stripeClient, at = now(), tenantIds = null } = {}) {
  const client = stripeClient || defaultStripeClient();
  const startedMs = Date.now();

  const report = {
    started_at: at.toISOString(),
    expired_reservations: 0,
    tenants_checked: 0,
    drift_corrected: 0,
    drift: [],
    errors: [],
    duration_ms: 0
  };

  report.expired_reservations = await releaseExpiredReservations(at);

  const all = await tenantRepo.listWithStripeCustomer(pool);
  const tenants = tenantIds ? all.filter((t) => tenantIds.includes(t.id)) : all;
  report.tenants_checked = tenants.length;

  for (const tenant of tenants) {
    // One tenant failing must not abandon the rest - the same rule the scraper
    // in A9 followed for one bad page.
    try {
      const result = await reconcileTenant(client, tenant);

      if (result.drifted) {
        report.drift_corrected += 1;
        report.drift.push(result);
      }
    } catch (error) {
      report.errors.push({ tenant_id: tenant.id, reason: error.message });
    }
  }

  report.duration_ms = Date.now() - startedMs;
  return report;
}

if (require.main === module) {
  reconcile()
    .then(async (report) => {
      console.log(JSON.stringify(report, null, 2));
      await pool.end();
    })
    .catch(async (error) => {
      console.error('reconcile failed:', error.message);
      await pool.end();
      process.exit(1);
    });
}

module.exports = { reconcile, releaseExpiredReservations };
