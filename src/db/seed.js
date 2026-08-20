'use strict';

// Seeds the two plans and two demo tenants. Safe to re-run: plans are upserted
// and tenants are keyed on their API key hash.
//
// The demo API keys are fixed rather than random so the README, the tests and
// the demo all refer to the same values. They are worthless outside a local
// database - only their SHA-256 is stored.

const crypto = require('node:crypto');

const { pool } = require('./pool');
const { PLANS } = require('../config/plans');

const DEMO_TENANTS = [
  { name: 'Acme Ltd', plan: 'free', apiKey: 'sk_demo_acme_0000000000000000' },
  { name: 'Globex Inc', plan: 'free', apiKey: 'sk_demo_globex_000000000000000' }
];

function hashApiKey(plaintext) {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

async function seedPlans() {
  for (const plan of Object.values(PLANS)) {
    await pool.query(
      `INSERT INTO plans (code, name, api_call_limit, token_limit, spend_cap_micros, stripe_price_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name,
         api_call_limit = EXCLUDED.api_call_limit,
         token_limit = EXCLUDED.token_limit,
         spend_cap_micros = EXCLUDED.spend_cap_micros,
         stripe_price_id = EXCLUDED.stripe_price_id`,
      [
        plan.code,
        plan.name,
        plan.api_call_limit,
        plan.token_limit,
        plan.spend_cap_micros,
        plan.stripe_price_id
      ]
    );
  }

  console.log(`seed: ${Object.keys(PLANS).length} plans`);
}

async function seedTenants() {
  for (const tenant of DEMO_TENANTS) {
    // DO NOTHING, not DO UPDATE. Seeding runs on every stack start, and an
    // upsert that rewrote plan_code would silently downgrade a tenant who had
    // just paid - the seed would quietly undo a real Stripe upgrade on restart.
    // Seed data creates tenants; it does not own their state afterwards.
    await pool.query(
      `INSERT INTO tenants (name, plan_code, api_key_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (api_key_hash) DO NOTHING`,
      [tenant.name, tenant.plan, hashApiKey(tenant.apiKey)]
    );

    const { rows } = await pool.query(
      'SELECT id, plan_code, subscription_status FROM tenants WHERE api_key_hash = $1',
      [hashApiKey(tenant.apiKey)]
    );

    const row = rows[0];
    console.log(`seed: tenant ${tenant.name} [${row.plan_code}/${row.subscription_status}] ${row.id}`);
    console.log(`        api key: ${tenant.apiKey}`);
  }
}

async function seed() {
  await seedPlans();
  await seedTenants();
}

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error('seed failed:', error.message);
      await pool.end();
      process.exit(1);
    });
}

module.exports = { seed, hashApiKey, DEMO_TENANTS };
