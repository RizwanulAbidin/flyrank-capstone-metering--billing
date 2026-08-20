'use strict';

// Everything that talks to Stripe. The client is built lazily so the rest of the
// app - and the whole test suite - runs without a live API key. Only creating a
// real Checkout session needs one.

const Stripe = require('stripe');

let client = null;

function stripe() {
  if (!client) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY must be set in .env');
    }

    if (process.env.STRIPE_SECRET_KEY.startsWith('sk_live_')) {
      // There is no reason for this project to ever hold a live key. Refusing is
      // cheaper than explaining a real charge.
      throw new Error('Refusing to start with a live Stripe key. Test mode only.');
    }

    client = new Stripe(process.env.STRIPE_SECRET_KEY);
  }

  return client;
}

async function createCheckoutSession({ tenant, successUrl, cancelUrl }) {
  if (!process.env.STRIPE_PRICE_ID_PRO) {
    throw new Error('STRIPE_PRICE_ID_PRO must be set in .env');
  }

  return stripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: process.env.STRIPE_PRICE_ID_PRO, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    // Both, deliberately. client_reference_id survives in the dashboard UI;
    // metadata is what the webhook reads. Losing the link between a payment and
    // a tenant is unrecoverable, so it is stored twice.
    client_reference_id: tenant.id,
    metadata: { tenant_id: tenant.id },
    subscription_data: { metadata: { tenant_id: tenant.id } }
  });
}

// Verifies the signature over the RAW request bytes. Throws if the payload was
// altered, the secret is wrong, or the timestamp is outside the tolerance.
function constructEvent(rawBody, signatureHeader) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET must be set in .env');
  }

  return Stripe.webhooks.constructEvent(
    rawBody,
    signatureHeader,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}

// Stripe reports many statuses; the database stores three. Anything that is not
// clearly good or clearly finished is treated as "past_due", which blocks
// billable requests with a 402 - the safe direction to be wrong in.
function mapSubscriptionStatus(stripeStatus) {
  if (stripeStatus === 'active' || stripeStatus === 'trialing') {
    return 'active';
  }

  if (stripeStatus === 'canceled' || stripeStatus === 'incomplete_expired') {
    return 'canceled';
  }

  return 'past_due';
}

function toDate(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000) : null;
}

module.exports = { createCheckoutSession, constructEvent, mapSubscriptionStatus, toDate };
