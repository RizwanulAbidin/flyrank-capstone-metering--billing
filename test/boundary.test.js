'use strict';

// The quota boundary, proved through the real request path against a real
// database. Uses purpose-built tiny plans so a boundary is three requests away
// rather than a thousand.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pool,
  ensurePlans,
  createPlan,
  createTenant,
  startServer,
  call,
  countUsageEvents
} = require('./helpers/testEnv');

const { fixedSimulator } = require('../src/services/workSimulator');

// No output, no reasoning: reserved equals actual, so the arithmetic below is
// exact and the boundary lands where it is supposed to.
const simulate = fixedSimulator(0, 0);

// 100 input tokens, nothing else. Costs 300 micros of tokens + 1,000 for the call.
const SMALL = { input_tokens: 100, cached_input_tokens: 0, max_output_tokens: 0 };
const COST_PER_SMALL_MICROS = 1_300;

async function usedTokens(tenantId) {
  const { rows } = await pool.query(
    "SELECT COALESCE(SUM(quantity),0)::int AS n FROM usage_events WHERE tenant_id=$1 AND usage_type='tokens'",
    [tenantId]
  );

  return rows[0].n;
}

test.after(() => pool.end());

test('exactly at the token limit is allowed; one more is refused', async () => {
  await ensurePlans();
  await createPlan({
    code: 'tiny_tokens',
    apiCallLimit: 1_000_000,
    tokenLimit: 1_000,
    spendCapMicros: 1_000_000_000
  });
  const tenant = await createTenant({ plan: 'tiny_tokens' });
  const server = await startServer({ simulate });

  try {
    // Ten requests of 100 tokens land exactly on 1,000.
    for (let i = 0; i < 10; i += 1) {
      const result = await call(server.url, { apiKey: tenant.apiKey, key: `k${i}`, body: SMALL });
      assert.equal(result.status, 200, `request ${i + 1} of 10 should be allowed`);
    }

    assert.equal(await usedTokens(tenant.id), 1_000);

    // The eleventh is the first one that does not fit.
    const overTheLine = await call(server.url, {
      apiKey: tenant.apiKey,
      key: 'k10',
      body: SMALL
    });

    assert.equal(overTheLine.status, 429);
    assert.equal(overTheLine.body.code, 'token_quota_exceeded');
    assert.equal(overTheLine.body.details.would_reach, 1_100);

    // Nothing was recorded by the refusal.
    assert.equal(await usedTokens(tenant.id), 1_000);
    assert.equal(await countUsageEvents(tenant.id), 10);
  } finally {
    await server.close();
  }
});

test('all-or-nothing: a request that does not fit does not eat the headroom either', async () => {
  await ensurePlans();
  await createPlan({
    code: 'tiny_tokens2',
    apiCallLimit: 1_000_000,
    tokenLimit: 1_000,
    spendCapMicros: 1_000_000_000
  });
  const tenant = await createTenant({ plan: 'tiny_tokens2' });
  const server = await startServer({ simulate });

  try {
    for (let i = 0; i < 9; i += 1) {
      await call(server.url, { apiKey: tenant.apiKey, key: `s${i}`, body: SMALL });
    }

    assert.equal(await usedTokens(tenant.id), 900);

    // Asks for 200 with only 100 left. Refused whole - it must not take the 100.
    const tooBig = await call(server.url, {
      apiKey: tenant.apiKey,
      key: 'big',
      body: { input_tokens: 200, cached_input_tokens: 0, max_output_tokens: 0 }
    });

    assert.equal(tooBig.status, 429);
    assert.equal(await usedTokens(tenant.id), 900, 'the refused request recorded nothing');

    // The 100 that was left is still there for a request that fits.
    const fits = await call(server.url, { apiKey: tenant.apiKey, key: 'fits', body: SMALL });

    assert.equal(fits.status, 200);
    assert.equal(await usedTokens(tenant.id), 1_000);
  } finally {
    await server.close();
  }
});

test('the spend cap blocks with 402 even when the token quota has room', async () => {
  await ensurePlans();
  await createPlan({
    code: 'tiny_money',
    apiCallLimit: 1_000_000,
    tokenLimit: 1_000_000,
    spendCapMicros: COST_PER_SMALL_MICROS * 2 // exactly two requests
  });
  const tenant = await createTenant({ plan: 'tiny_money' });
  const server = await startServer({ simulate });

  try {
    assert.equal((await call(server.url, { apiKey: tenant.apiKey, key: 'm0', body: SMALL })).status, 200);
    assert.equal((await call(server.url, { apiKey: tenant.apiKey, key: 'm1', body: SMALL })).status, 200);

    const third = await call(server.url, { apiKey: tenant.apiKey, key: 'm2', body: SMALL });

    assert.equal(third.status, 402, 'money limits are 402, not 429');
    assert.equal(third.body.code, 'spend_cap_exceeded');

    // Strict equality on purpose. bigint columns arrive from Postgres as strings,
    // and a money value that is secretly "2600" instead of 2600 breaks the moment
    // anything adds to it. This assertion is what caught that.
    assert.strictEqual(third.body.details.cap_micros, 2_600);
    assert.strictEqual(third.body.details.would_reach_micros, 3_900);
    assert.equal(typeof third.body.details.cap_micros, 'number');

    // The token quota had plenty of room - it was money that ran out.
    assert.equal(await usedTokens(tenant.id), 200);
  } finally {
    await server.close();
  }
});

test('the API call quota blocks with 429', async () => {
  await ensurePlans();
  await createPlan({
    code: 'tiny_calls',
    apiCallLimit: 2,
    tokenLimit: 1_000_000,
    spendCapMicros: 1_000_000_000
  });
  const tenant = await createTenant({ plan: 'tiny_calls' });
  const server = await startServer({ simulate });

  try {
    await call(server.url, { apiKey: tenant.apiKey, key: 'c0', body: SMALL });
    await call(server.url, { apiKey: tenant.apiKey, key: 'c1', body: SMALL });

    const third = await call(server.url, { apiKey: tenant.apiKey, key: 'c2', body: SMALL });

    assert.equal(third.status, 429);
    assert.equal(third.body.code, 'api_call_quota_exceeded');
  } finally {
    await server.close();
  }
});

test('an inactive subscription is refused with 402 before any counting', async () => {
  await ensurePlans();
  const tenant = await createTenant({ status: 'past_due' });
  const server = await startServer({ simulate });

  try {
    const result = await call(server.url, { apiKey: tenant.apiKey, key: 'p0', body: SMALL });

    assert.equal(result.status, 402);
    assert.equal(result.body.code, 'subscription_inactive');
    assert.equal(await countUsageEvents(tenant.id), 0);
  } finally {
    await server.close();
  }
});

test('twenty concurrent requests cannot overshoot a five-request limit', async () => {
  await ensurePlans();
  await createPlan({
    code: 'race_plan',
    apiCallLimit: 1_000_000,
    tokenLimit: 500, // exactly five 100-token requests
    spendCapMicros: 1_000_000_000
  });
  const tenant = await createTenant({ plan: 'race_plan' });
  const server = await startServer({ simulate });

  try {
    // Twenty DIFFERENT requests, all at once. Idempotency does not help here -
    // every one is legitimately distinct. Only the reservation rows stop them.
    const results = await Promise.all(
      Array.from({ length: 20 }, (unused, i) =>
        call(server.url, { apiKey: tenant.apiKey, key: `race-${i}`, body: SMALL })
      )
    );

    const allowed = results.filter((r) => r.status === 200).length;
    const refused = results.filter((r) => r.status === 429).length;

    assert.equal(allowed, 5, `expected exactly 5 to fit, got ${allowed}`);
    assert.equal(refused, 15);

    // The number that actually matters: the tenant never went over.
    assert.equal(await usedTokens(tenant.id), 500);
    assert.ok(await usedTokens(tenant.id) <= 500);
  } finally {
    await server.close();
  }
});

test('a refusal does not poison the idempotency key - retrying after an upgrade works', async () => {
  await ensurePlans();
  await createPlan({
    code: 'upgrade_from',
    apiCallLimit: 1,
    tokenLimit: 1_000_000,
    spendCapMicros: 1_000_000_000
  });
  await createPlan({
    code: 'upgrade_to',
    apiCallLimit: 100,
    tokenLimit: 1_000_000,
    spendCapMicros: 1_000_000_000
  });
  const tenant = await createTenant({ plan: 'upgrade_from' });
  const server = await startServer({ simulate });

  try {
    await call(server.url, { apiKey: tenant.apiKey, key: 'u0', body: SMALL });

    const refused = await call(server.url, { apiKey: tenant.apiKey, key: 'RETRY-ME', body: SMALL });
    assert.equal(refused.status, 429);

    // The tenant upgrades, exactly as a Stripe webhook would do it.
    await pool.query('UPDATE tenants SET plan_code = $2 WHERE id = $1', [tenant.id, 'upgrade_to']);

    // Same key as the refused attempt. If the rejection had been stored against
    // the key, this would replay a stale 429 forever.
    const afterUpgrade = await call(server.url, {
      apiKey: tenant.apiKey,
      key: 'RETRY-ME',
      body: SMALL
    });

    assert.equal(afterUpgrade.status, 200, 'the upgraded tenant must not be served a stale refusal');
    assert.equal(await countUsageEvents(tenant.id), 2);
  } finally {
    await server.close();
  }
});
