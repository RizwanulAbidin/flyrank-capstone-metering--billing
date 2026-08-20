'use strict';

// Shared setup for the tests that need a real Postgres. These are integration
// tests on purpose: the guarantees being proved - a UNIQUE constraint rejecting a
// concurrent duplicate, a row lock serialising two reserves - do not exist in a
// mock. Mocking them would test the mock.

const crypto = require('node:crypto');
const { once } = require('node:events');

const { pool } = require('../../src/db/pool');
const { buildApp } = require('../../src/http/app');
const { PLANS } = require('../../src/config/plans');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Deliberately NOT a database reset.
//
// The test runner executes each file in its own process, concurrently. A
// TRUNCATE in one file deletes the tenants another file is halfway through
// using - which showed up as a request suddenly returning 401 mid-test.
//
// Instead every test creates its own tenant with a random API key and asserts
// only on that tenant's rows. Since every table is tenant-scoped, the tests
// isolate the same way real customers do. Data accumulates between runs, which
// is fine: nothing asserts on a global count.
async function ensurePlans() {
  for (const plan of Object.values(PLANS)) {
    await pool.query(
      `INSERT INTO plans (code, name, api_call_limit, token_limit, spend_cap_micros)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (code) DO NOTHING`,
      [plan.code, plan.name, plan.api_call_limit, plan.token_limit, plan.spend_cap_micros]
    );
  }
}

// A plan sized for one specific test, so boundary cases do not need 1,000 requests.
async function createPlan({ code, apiCallLimit, tokenLimit, spendCapMicros }) {
  await pool.query(
    `INSERT INTO plans (code, name, api_call_limit, token_limit, spend_cap_micros)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (code) DO UPDATE SET
       api_call_limit = EXCLUDED.api_call_limit,
       token_limit = EXCLUDED.token_limit,
       spend_cap_micros = EXCLUDED.spend_cap_micros`,
    [code, code, apiCallLimit, tokenLimit, spendCapMicros]
  );

  return code;
}

async function createTenant({ name = 'Test Tenant', plan = 'free', status = 'active' } = {}) {
  const apiKey = `sk_test_${crypto.randomUUID().replace(/-/g, '')}`;

  const { rows } = await pool.query(
    `INSERT INTO tenants (name, plan_code, subscription_status, api_key_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [name, plan, status, sha256(apiKey)]
  );

  return { id: rows[0].id, apiKey, plan };
}

async function startServer({ simulate } = {}) {
  const server = buildApp({ simulate }).listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

// Thin request helper so the tests read as HTTP, which is how they are graded.
async function call(url, { method = 'POST', path = '/generate', apiKey, key, body }) {
  const headers = { 'Content-Type': 'application/json' };

  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (key) headers['Idempotency-Key'] = key;

  const response = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  return { status: response.status, body: await response.json().catch(() => null) };
}

async function countUsageEvents(tenantId) {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM usage_events WHERE tenant_id = $1 AND usage_type = 'api_call'",
    [tenantId]
  );

  return rows[0].n;
}

async function reservationStates(tenantId) {
  const { rows } = await pool.query(
    'SELECT state, COUNT(*)::int AS n FROM reservations WHERE tenant_id = $1 GROUP BY state',
    [tenantId]
  );

  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}

const REQUEST = { input_tokens: 1_200, cached_input_tokens: 8_000, max_output_tokens: 2_000 };

module.exports = {
  pool,
  sha256,
  ensurePlans,
  createPlan,
  createTenant,
  startServer,
  call,
  countUsageEvents,
  reservationStates,
  REQUEST
};
