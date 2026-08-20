'use strict';

// QuotaService is a pure decision function, so every boundary case can be checked
// without a database or a server. The integration tests then prove the same rules
// survive a real request path.

const test = require('node:test');
const assert = require('node:assert/strict');

const { check, remaining } = require('../src/services/QuotaService');

const PLAN = { api_call_limit: 1_000, token_limit: 100_000, spend_cap_micros: 1_000_000 };
const NONE = { calls: 0, tokens: 0, cost_micros: 0 };

function ask({ committed = NONE, held = NONE, requested, subscriptionStatus = 'active' }) {
  return check({ plan: PLAN, subscriptionStatus, committed, held, requested });
}

// --------------------------------------------------------------------------
// The boundary. "1,000 calls per month" means you get 1,000, and the 1,001st is
// refused. Written as three tests because off-by-one is the classic bug here.
// --------------------------------------------------------------------------

test('just under the limit is allowed', () => {
  const result = ask({
    committed: { calls: 998, tokens: 0, cost_micros: 0 },
    requested: { calls: 1, tokens: 0, cost_micros: 0 }
  });

  assert.equal(result.allowed, true);
});

test('landing exactly on the limit is allowed', () => {
  const result = ask({
    committed: { calls: 999, tokens: 0, cost_micros: 0 },
    requested: { calls: 1, tokens: 0, cost_micros: 0 }
  });

  assert.equal(result.allowed, true);
});

test('one past the limit is refused with 429', () => {
  const result = ask({
    committed: { calls: 1_000, tokens: 0, cost_micros: 0 },
    requested: { calls: 1, tokens: 0, cost_micros: 0 }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.error.status, 429);
  assert.equal(result.error.code, 'api_call_quota_exceeded');
});

// --------------------------------------------------------------------------
// All-or-nothing. A request that does not fit is refused whole; it does not get
// to consume the headroom that IS available.
// --------------------------------------------------------------------------

test('a request that overshoots is refused rather than partially allowed', () => {
  const result = ask({
    committed: { calls: 0, tokens: 99_998, cost_micros: 0 },
    requested: { calls: 0, tokens: 5, cost_micros: 0 }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.error.code, 'token_quota_exceeded');
  assert.equal(result.error.details.would_reach, 100_003);
});

// --------------------------------------------------------------------------
// Held reservations count. This is what stops concurrent requests overshooting.
// --------------------------------------------------------------------------

test('a held reservation counts against the limit even though it is not spent yet', () => {
  const withoutHold = ask({
    committed: { calls: 500, tokens: 0, cost_micros: 0 },
    requested: { calls: 400, tokens: 0, cost_micros: 0 }
  });

  const withHold = ask({
    committed: { calls: 500, tokens: 0, cost_micros: 0 },
    held: { calls: 400, tokens: 0, cost_micros: 0 },
    requested: { calls: 400, tokens: 0, cost_micros: 0 }
  });

  assert.equal(withoutHold.allowed, true);
  assert.equal(withHold.allowed, false, 'the in-flight request must be counted');
});

// --------------------------------------------------------------------------
// Which code, and in what order.
// --------------------------------------------------------------------------

test('an inactive subscription is 402 before any limit is even looked at', () => {
  const result = ask({
    subscriptionStatus: 'past_due',
    requested: { calls: 1, tokens: 1, cost_micros: 1 }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.error.status, 402);
  assert.equal(result.error.code, 'subscription_inactive');
});

test('the spend cap is 402, not 429 - money is a plan problem, not an allowance', () => {
  const result = ask({
    committed: { calls: 0, tokens: 0, cost_micros: 999_999 },
    requested: { calls: 0, tokens: 0, cost_micros: 2 }
  });

  assert.equal(result.allowed, false);
  assert.equal(result.error.status, 402);
  assert.equal(result.error.code, 'spend_cap_exceeded');
});

test('when the spend cap and the token quota are both blown, the cap wins', () => {
  const result = ask({
    committed: { calls: 0, tokens: 100_000, cost_micros: 1_000_000 },
    requested: { calls: 0, tokens: 1, cost_micros: 1 }
  });

  // Documented precedence: subscription, then spend cap, then counted quotas.
  // Without a stated order this answer would differ by code path.
  assert.equal(result.error.code, 'spend_cap_exceeded');
});

test('a rejection explains itself with numbers, not just a status code', () => {
  const result = ask({
    committed: { calls: 0, tokens: 90_000, cost_micros: 0 },
    held: { calls: 0, tokens: 9_000, cost_micros: 0 },
    requested: { calls: 0, tokens: 5_000, cost_micros: 0 }
  });

  assert.deepEqual(result.error.details, {
    limit: 'token_limit',
    cap: 100_000,
    committed: 90_000,
    held: 9_000,
    requested: 5_000,
    would_reach: 104_000
  });
});

test('an empty request against an empty account is allowed', () => {
  assert.equal(ask({ requested: NONE }).allowed, true);
});

// --------------------------------------------------------------------------
// remaining()
// --------------------------------------------------------------------------

test('remaining subtracts both committed usage and held reservations', () => {
  const left = remaining(
    PLAN,
    { calls: 100, tokens: 10_000, cost_micros: 100_000 },
    { calls: 5, tokens: 500, cost_micros: 5_000 }
  );

  assert.deepEqual(left, { calls: 895, tokens: 89_500, spend_micros: 895_000 });
});

test('remaining never goes negative', () => {
  const left = remaining(PLAN, { calls: 5_000, tokens: 999_999, cost_micros: 9_000_000 }, NONE);

  assert.deepEqual(left, { calls: 0, tokens: 0, spend_micros: 0 });
});
