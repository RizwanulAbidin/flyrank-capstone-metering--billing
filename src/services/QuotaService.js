'use strict';

// Pure decision function: given what a tenant has spent, what they have promised,
// and what they are asking for, may this request proceed?
//
// No database, no clock, no HTTP. Everything it needs is passed in, which is why
// every boundary case can be tested without a server running.

const { ApiError } = require('../errors');

// Checked in this order, first failure wins. The order is a documented policy,
// not an accident: without one, "which code when two limits are exceeded?" gets
// answered differently in different code paths.
//
//   1. subscription not active   -> 402   plan or payment problem
//   2. spend cap exceeded        -> 402   money limit; upgrading fixes it
//   3. call or token quota       -> 429   counted allowance used up
//
// The dividing line: 429 means an allowance is used up, 402 means money or plan
// state is the problem.
function check({ plan, subscriptionStatus, committed, held, requested }) {
  if (subscriptionStatus !== 'active') {
    return deny(402, 'subscription_inactive', 'Subscription is not active', {
      subscription_status: subscriptionStatus
    });
  }

  const projectedCost = committed.cost_micros + held.cost_micros + requested.cost_micros;

  if (projectedCost > plan.spend_cap_micros) {
    return deny(402, 'spend_cap_exceeded', 'Monthly spend cap would be exceeded', {
      limit: 'spend_cap_micros',
      cap_micros: plan.spend_cap_micros,
      committed_micros: committed.cost_micros,
      held_micros: held.cost_micros,
      requested_micros: requested.cost_micros,
      would_reach_micros: projectedCost
    });
  }

  const projectedCalls = committed.calls + held.calls + requested.calls;

  if (projectedCalls > plan.api_call_limit) {
    return deny(429, 'api_call_quota_exceeded', 'Monthly API call quota would be exceeded', {
      limit: 'api_call_limit',
      cap: plan.api_call_limit,
      committed: committed.calls,
      held: held.calls,
      requested: requested.calls,
      would_reach: projectedCalls
    });
  }

  const projectedTokens = committed.tokens + held.tokens + requested.tokens;

  if (projectedTokens > plan.token_limit) {
    return deny(429, 'token_quota_exceeded', 'Monthly token quota would be exceeded', {
      limit: 'token_limit',
      cap: plan.token_limit,
      committed: committed.tokens,
      held: held.tokens,
      requested: requested.tokens,
      would_reach: projectedTokens
    });
  }

  return { allowed: true };
}

function deny(status, code, message, details) {
  return {
    allowed: false,
    error: new ApiError(status, code, message, details)
  };
}

// What is left, for GET /usage. Never negative: a tenant sitting exactly at the
// limit has zero remaining, not a negative allowance.
function remaining(plan, committed, held) {
  return {
    calls: Math.max(0, plan.api_call_limit - committed.calls - held.calls),
    tokens: Math.max(0, plan.token_limit - committed.tokens - held.tokens),
    spend_micros: Math.max(0, plan.spend_cap_micros - committed.cost_micros - held.cost_micros)
  };
}

module.exports = { check, remaining };
