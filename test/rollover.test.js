'use strict';

// Quotas are monthly, so the month boundary is a real piece of business logic
// and not an implementation detail. Every date here is pinned through the
// injectable clock - a rollover you cannot pin is a rollover you can only hope
// about.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pool,
  ensurePlans,
  createPlan,
  createTenant,
  startServer,
  call
} = require('./helpers/testEnv');

const { setNow } = require('../src/clock');
const { fixedSimulator } = require('../src/services/workSimulator');

const simulate = fixedSimulator(0, 0);
const SMALL = { input_tokens: 100, cached_input_tokens: 0, max_output_tokens: 0 };

const AUGUST = '2026-08-20T12:00:00.000Z';
const AUGUST_LAST_SECOND = '2026-08-31T23:59:59.000Z';
const SEPTEMBER_FIRST_SECOND = '2026-09-01T00:00:00.000Z';

test.after(() => pool.end());

test('usage recorded in one month does not count against the next', async () => {
  await ensurePlans();
  await createPlan({
    code: 'rollover_a',
    apiCallLimit: 1_000_000,
    tokenLimit: 300,
    spendCapMicros: 1_000_000_000
  });
  const tenant = await createTenant({ plan: 'rollover_a' });
  const server = await startServer({ simulate });
  let restore = setNow(AUGUST);

  try {
    // Fill August exactly: three 100-token requests against a 300 limit.
    for (let i = 0; i < 3; i += 1) {
      const result = await call(server.url, { apiKey: tenant.apiKey, key: `aug-${i}`, body: SMALL });
      assert.equal(result.status, 200, `August request ${i + 1} should fit`);
    }

    const fourth = await call(server.url, { apiKey: tenant.apiKey, key: 'aug-3', body: SMALL });
    assert.equal(fourth.status, 429, 'August is full');

    const august = await call(server.url, { method: 'GET', path: '/usage', apiKey: tenant.apiKey });
    assert.equal(august.body.billing_period, '2026-08-01');
    assert.equal(august.body.used.tokens, 300);
    assert.equal(august.body.remaining.tokens, 0);

    // Same tenant, same plan, new month.
    restore();
    restore = setNow(SEPTEMBER_FIRST_SECOND);

    const september = await call(server.url, {
      method: 'GET',
      path: '/usage',
      apiKey: tenant.apiKey
    });

    assert.equal(september.body.billing_period, '2026-09-01');
    assert.equal(september.body.used.tokens, 0, 'September starts empty');
    assert.equal(september.body.remaining.tokens, 300, 'the full allowance is back');

    const fresh = await call(server.url, { apiKey: tenant.apiKey, key: 'sep-0', body: SMALL });
    assert.equal(fresh.status, 200, 'the request refused in August succeeds in September');
  } finally {
    restore();
    await server.close();
  }
});

test('the boundary is one second wide, not one day', async () => {
  await ensurePlans();
  await createPlan({
    code: 'rollover_b',
    apiCallLimit: 1_000_000,
    tokenLimit: 100,
    spendCapMicros: 1_000_000_000
  });
  const tenant = await createTenant({ plan: 'rollover_b' });
  const server = await startServer({ simulate });
  let restore = setNow(AUGUST_LAST_SECOND);

  try {
    const lastMoment = await call(server.url, {
      apiKey: tenant.apiKey,
      key: 'last',
      body: SMALL
    });
    assert.equal(lastMoment.status, 200);

    // One more second. Nothing else changes.
    restore();
    restore = setNow(SEPTEMBER_FIRST_SECOND);

    const firstMoment = await call(server.url, {
      apiKey: tenant.apiKey,
      key: 'first',
      body: SMALL
    });

    assert.equal(
      firstMoment.status,
      200,
      'a request one second later is in a new period and must be allowed'
    );

    const usage = await call(server.url, { method: 'GET', path: '/usage', apiKey: tenant.apiKey });
    assert.equal(usage.body.billing_period, '2026-09-01');
    assert.equal(usage.body.used.tokens, 100, 'September sees only its own request');
  } finally {
    restore();
    await server.close();
  }
});

test('events are filed under the period they happened in, not the period we ask in', async () => {
  await ensurePlans();
  const tenant = await createTenant();
  const server = await startServer({ simulate });
  let restore = setNow(AUGUST);

  try {
    await call(server.url, { apiKey: tenant.apiKey, key: 'filed-aug', body: SMALL });

    restore();
    restore = setNow(SEPTEMBER_FIRST_SECOND);

    await call(server.url, { apiKey: tenant.apiKey, key: 'filed-sep', body: SMALL });

    const { rows } = await pool.query(
      `SELECT to_char(billing_period, 'YYYY-MM-DD') AS period, count(*)::int AS n
       FROM usage_events
       WHERE tenant_id = $1 AND usage_type = 'api_call'
       GROUP BY billing_period ORDER BY billing_period`,
      [tenant.id]
    );

    assert.deepEqual(
      rows,
      [
        { period: '2026-08-01', n: 1 },
        { period: '2026-09-01', n: 1 }
      ],
      'each event keeps the period it was recorded in'
    );
  } finally {
    restore();
    await server.close();
  }
});

test('a held reservation only counts against its own month', async () => {
  await ensurePlans();
  const tenant = await createTenant();
  let restore = setNow(AUGUST);

  try {
    await pool.query(
      `INSERT INTO reservations
         (tenant_id, estimated_calls, estimated_tokens, estimated_cost_micros,
          state, billing_period, expires_at)
       VALUES ($1, 1, 50000, 1000, 'held', '2026-08-01', now() + interval '5 minutes')`,
      [tenant.id]
    );

    const server = await startServer({ simulate });

    try {
      const august = await call(server.url, {
        method: 'GET',
        path: '/usage',
        apiKey: tenant.apiKey
      });
      assert.equal(august.body.held.tokens, 50_000, 'August sees the hold');

      restore();
      restore = setNow(SEPTEMBER_FIRST_SECOND);

      const september = await call(server.url, {
        method: 'GET',
        path: '/usage',
        apiKey: tenant.apiKey
      });
      assert.equal(september.body.held.tokens, 0, 'September does not inherit it');
    } finally {
      await server.close();
    }
  } finally {
    restore();
  }
});
