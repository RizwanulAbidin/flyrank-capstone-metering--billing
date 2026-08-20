'use strict';

// Claim an event id, or discover someone already did. Same principle as the
// idempotency keys: the database decides, not a prior read.
//
// ON CONFLICT DO NOTHING rather than catch-the-unique-violation, because this
// runs inside the same transaction that applies the event. A raised constraint
// error would abort that transaction and every statement after it would fail
// with "current transaction is aborted".
async function claim(client, stripeEventId, eventType) {
  const { rows } = await client.query(
    `INSERT INTO processed_webhook_events (stripe_event_id, event_type)
     VALUES ($1, $2)
     ON CONFLICT (stripe_event_id) DO NOTHING
     RETURNING stripe_event_id`,
    [stripeEventId, eventType]
  );

  return rows.length === 1;
}

async function wasProcessed(executor, stripeEventId) {
  const { rows } = await executor.query(
    'SELECT stripe_event_id FROM processed_webhook_events WHERE stripe_event_id = $1',
    [stripeEventId]
  );

  return rows.length === 1;
}

module.exports = { claim, wasProcessed };
