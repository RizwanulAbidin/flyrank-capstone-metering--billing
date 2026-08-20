'use strict';

// All SQL touching tenants and plans lives here. Services never write SQL.

const { pool } = require('../db/pool');

const TENANT_WITH_PLAN = `
  SELECT
    t.id, t.name, t.plan_code, t.subscription_status, t.stripe_customer_id,
    p.api_call_limit, p.token_limit, p.spend_cap_micros
  FROM tenants t
  JOIN plans p ON p.code = t.plan_code
`;

// node-postgres returns bigint columns as STRINGS, to avoid silently losing
// precision on values above 2^53. Money columns are bigint, so every micros value
// arrives here as text and has to be converted exactly once, at this boundary.
//
// This is not cosmetic. `4000 > '2600'` coerces and gives the right answer, so a
// string spend cap almost works - right up until it is compared with === , or
// added to something, or serialised into a response as "2600".
function mapTenant(row) {
  if (!row) {
    return null;
  }

  return { ...row, spend_cap_micros: Number(row.spend_cap_micros) };
}

async function findByApiKeyHash(apiKeyHash) {
  const { rows } = await pool.query(`${TENANT_WITH_PLAN} WHERE t.api_key_hash = $1`, [apiKeyHash]);
  return mapTenant(rows[0]);
}

async function findById(tenantId) {
  const { rows } = await pool.query(`${TENANT_WITH_PLAN} WHERE t.id = $1`, [tenantId]);
  return mapTenant(rows[0]);
}

// Serialises reservations for ONE tenant. Two requests for the same tenant queue
// here; requests for different tenants are unaffected. Without this, two
// concurrent reserves can both read the same headroom and both be granted.
async function lockForUpdate(client, tenantId) {
  const { rows } = await client.query(
    `${TENANT_WITH_PLAN} WHERE t.id = $1 FOR UPDATE OF t`,
    [tenantId]
  );
  return mapTenant(rows[0]);
}

async function setPlan(client, tenantId, planCode, subscriptionStatus) {
  await client.query(
    'UPDATE tenants SET plan_code = $2, subscription_status = $3 WHERE id = $1',
    [tenantId, planCode, subscriptionStatus]
  );
}

module.exports = { findByApiKeyHash, findById, lockForUpdate, setPlan };
