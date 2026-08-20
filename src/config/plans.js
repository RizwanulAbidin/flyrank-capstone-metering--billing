'use strict';

// Three limits per plan, because a tenant can run out three different ways.
//
// The free spend cap is deliberately low against its token quota: 100,000 output
// tokens costs $1.50, so an output-heavy workload hits the MONEY cap first while
// a cached-input-heavy one hits the TOKEN count first. Both orders are tested.

const PLANS = Object.freeze({
  free: Object.freeze({
    code: 'free',
    name: 'Free',
    api_call_limit: 1_000,
    token_limit: 100_000,
    spend_cap_micros: 1_000_000, // $1.00
    stripe_price_id: null
  }),
  pro: Object.freeze({
    code: 'pro',
    name: 'Pro',
    api_call_limit: 50_000,
    token_limit: 5_000_000,
    spend_cap_micros: 100_000_000, // $100.00
    stripe_price_id: process.env.STRIPE_PRICE_ID_PRO || null
  })
});

module.exports = { PLANS };
