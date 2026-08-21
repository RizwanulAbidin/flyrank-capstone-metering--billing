'use strict';

const { pool } = require('../db/pool');

async function insertEvent(client, event) {
  const { rows } = await client.query(
    `INSERT INTO usage_events
       (tenant_id, usage_type, quantity, cost_micros, breakdown,
        reservation_id, idempotency_key_id, billing_period, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      event.tenantId,
      event.usageType,
      event.quantity,
      event.costMicros,
      event.breakdown ? JSON.stringify(event.breakdown) : null,
      event.reservationId,
      event.idempotencyKeyId,
      event.billingPeriod,
      event.occurredAt
    ]
  );

  return rows[0];
}

const TOTALS_SQL = `
  SELECT
    COALESCE(SUM(quantity) FILTER (WHERE usage_type = 'api_call'), 0)::int AS calls,
    COALESCE(SUM(quantity) FILTER (WHERE usage_type = 'tokens'), 0)::int   AS tokens,
    COALESCE(SUM(cost_micros), 0)::bigint                                  AS cost_micros
  FROM usage_events
  WHERE tenant_id = $1 AND billing_period = $2
`;

// Uses the (tenant_id, billing_period) index. This is the read behind every
// quota check and every /usage response.
async function committedTotals(executor, tenantId, billingPeriod) {
  const { rows } = await executor.query(TOTALS_SQL, [tenantId, billingPeriod]);

  return {
    calls: rows[0].calls,
    tokens: rows[0].tokens,
    cost_micros: Number(rows[0].cost_micros)
  };
}

// The tenant's own recent activity. Scoped to one tenant like every other read
// here - there is deliberately no "list all tenants" query anywhere in this
// codebase, because a dashboard is not a reason to undo tenant isolation.
async function recentEvents(executor, tenantId, limit = 25) {
  const { rows } = await executor.query(
    `SELECT usage_type, quantity, cost_micros, breakdown, occurred_at,
            to_char(billing_period, 'YYYY-MM-DD') AS billing_period
     FROM usage_events
     WHERE tenant_id = $1
     ORDER BY occurred_at DESC, id DESC
     LIMIT $2`,
    [tenantId, limit]
  );

  return rows.map((row) => ({ ...row, cost_micros: Number(row.cost_micros) }));
}

async function countEventsForKey(idempotencyKeyId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM usage_events WHERE idempotency_key_id = $1',
    [idempotencyKeyId]
  );

  return rows[0].count;
}

module.exports = { insertEvent, committedTotals, recentEvents, countEventsForKey };
