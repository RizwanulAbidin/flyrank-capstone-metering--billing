'use strict';

// Demo fixtures. Puts two tenants deliberately close to a limit so the boundary
// is one request away instead of a thousand, and so the two ways of running out
// - allowance and money - can each be shown in a few seconds.
//
// Separate from `seed.js` on purpose: the normal seed sets up a clean system,
// this one manufactures a specific situation. Re-running it resets both tenants
// to their starting position.

const crypto = require('node:crypto');

const { pool } = require('./pool');
const { billingPeriod } = require('../clock');

const DEMO = [
  {
    name: 'Nearly Full Ltd',
    apiKey: 'sk_demo_nearlyfull_00000000000',
    // Free allows 100,000 tokens. A typical demo request RESERVES 13,200
    // (1200 input + 8000 cached + 2000 output + 2000 reasoning allowance), so the
    // starting point has to leave room for exactly one of them:
    //   80,000 + 13,200 =  93,200  -> fits
    //   then ~90,000 + 13,200 > 100,000 -> the second is refused
    // Pre-loaded as cheap cached input so the TOKEN limit binds, not the money one.
    tokens: 80_000,
    costMicros: 24_000,
    why: 'token quota is one request away'
  },
  {
    name: 'Nearly Broke Ltd',
    apiKey: 'sk_demo_nearlybroke_0000000000',
    // Free caps spending at $1.00. Pre-load $0.98 against a tiny token count, so
    // the MONEY limit binds long before the allowance does.
    tokens: 2_000,
    costMicros: 980_000,
    why: 'spend cap is one request away'
  }
];

function hashApiKey(plaintext) {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

async function reset(tenant) {
  const apiKeyHash = hashApiKey(tenant.apiKey);

  await pool.query(
    `INSERT INTO tenants (name, plan_code, api_key_hash)
     VALUES ($1, 'free', $2)
     ON CONFLICT (api_key_hash) DO NOTHING`,
    [tenant.name, apiKeyHash]
  );

  const { rows } = await pool.query('SELECT id FROM tenants WHERE api_key_hash = $1', [apiKeyHash]);
  const tenantId = rows[0].id;

  // Put the tenant back on its starting line, so the demo can be rehearsed twice.
  await pool.query('DELETE FROM usage_events WHERE tenant_id = $1', [tenantId]);
  await pool.query('DELETE FROM reservations WHERE tenant_id = $1', [tenantId]);
  await pool.query('DELETE FROM idempotency_keys WHERE tenant_id = $1', [tenantId]);
  await pool.query(
    "UPDATE tenants SET plan_code = 'free', subscription_status = 'active' WHERE id = $1",
    [tenantId]
  );

  const period = billingPeriod();

  await pool.query(
    `INSERT INTO usage_events
       (tenant_id, usage_type, quantity, cost_micros, billing_period, occurred_at)
     VALUES ($1, 'tokens', $2, $3, $4, now())`,
    [tenantId, tenant.tokens, tenant.costMicros, period]
  );

  return tenantId;
}

async function seedDemo() {
  for (const tenant of DEMO) {
    const id = await reset(tenant);

    console.log(`demo: ${tenant.name} - ${tenant.why}`);
    console.log(`        id      : ${id}`);
    console.log(`        api key : ${tenant.apiKey}`);
    console.log(`        starting: ${tenant.tokens} tokens, ${tenant.costMicros} micros used`);
  }
}

if (require.main === module) {
  seedDemo()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error('demo seed failed:', error.message);
      await pool.end();
      process.exit(1);
    });
}

module.exports = { seedDemo, DEMO };
