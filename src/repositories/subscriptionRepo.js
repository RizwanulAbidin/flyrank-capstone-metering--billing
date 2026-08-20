'use strict';

async function upsert(client, subscription) {
  await client.query(
    `INSERT INTO subscriptions
       (tenant_id, stripe_subscription_id, status, current_period_start, current_period_end, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (stripe_subscription_id) DO UPDATE SET
       status               = EXCLUDED.status,
       current_period_start = EXCLUDED.current_period_start,
       current_period_end   = EXCLUDED.current_period_end,
       updated_at           = now()`,
    [
      subscription.tenantId,
      subscription.stripeSubscriptionId,
      subscription.status,
      subscription.currentPeriodStart,
      subscription.currentPeriodEnd
    ]
  );
}

async function findByTenant(executor, tenantId) {
  const { rows } = await executor.query(
    'SELECT * FROM subscriptions WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 1',
    [tenantId]
  );

  return rows[0] || null;
}

module.exports = { upsert, findByTenant };
