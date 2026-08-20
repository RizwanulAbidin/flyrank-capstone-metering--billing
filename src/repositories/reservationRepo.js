'use strict';

async function insertHeld(client, reservation) {
  const { rows } = await client.query(
    `INSERT INTO reservations
       (tenant_id, idempotency_key_id, estimated_calls, estimated_tokens,
        estimated_cost_micros, state, billing_period, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'held', $6, $7)
     RETURNING *`,
    [
      reservation.tenantId,
      reservation.idempotencyKeyId,
      reservation.estimatedCalls,
      reservation.estimatedTokens,
      reservation.estimatedCostMicros,
      reservation.billingPeriod,
      reservation.expiresAt
    ]
  );

  return rows[0];
}

// What this tenant has already promised but not yet spent. Read on every request:
// a held reservation is a row, which is why ten simultaneous requests cannot all
// see the same headroom.
async function heldTotals(client, tenantId, billingPeriod) {
  const { rows } = await client.query(
    `SELECT
       COALESCE(SUM(estimated_calls), 0)::int        AS calls,
       COALESCE(SUM(estimated_tokens), 0)::int       AS tokens,
       COALESCE(SUM(estimated_cost_micros), 0)::bigint AS cost_micros
     FROM reservations
     WHERE tenant_id = $1 AND billing_period = $2 AND state = 'held'`,
    [tenantId, billingPeriod]
  );

  return {
    calls: rows[0].calls,
    tokens: rows[0].tokens,
    cost_micros: Number(rows[0].cost_micros)
  };
}

async function setState(client, id, state) {
  await client.query('UPDATE reservations SET state = $2 WHERE id = $1', [id, state]);
}

// Anything still held past its expiry is released. A process that dies between
// reserve and commit must not lock quota away permanently.
async function expireStale(client, asOf) {
  const { rows } = await client.query(
    `UPDATE reservations
     SET state = 'expired'
     WHERE state = 'held' AND expires_at < $1
     RETURNING id`,
    [asOf]
  );

  return rows.length;
}

module.exports = { insertHeld, heldTotals, setState, expireStale };
