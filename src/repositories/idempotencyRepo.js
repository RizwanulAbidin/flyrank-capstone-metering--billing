'use strict';

const UNIQUE_VIOLATION = '23505';

// Insert first, then ask questions. If a concurrent request already claimed this
// key the database rejects us with 23505, and that rejection - not a prior read -
// is what guarantees only one caller proceeds.
async function claim(client, { tenantId, endpoint, key, requestFingerprint }) {
  try {
    const { rows } = await client.query(
      `INSERT INTO idempotency_keys (tenant_id, endpoint, key, request_fingerprint, state)
       VALUES ($1, $2, $3, $4, 'in_progress')
       RETURNING *`,
      [tenantId, endpoint, key, requestFingerprint]
    );

    return { claimed: true, row: rows[0] };
  } catch (error) {
    if (error.code !== UNIQUE_VIOLATION) {
      throw error;
    }

    return { claimed: false, row: null };
  }
}

async function find(client, { tenantId, endpoint, key }) {
  const { rows } = await client.query(
    'SELECT * FROM idempotency_keys WHERE tenant_id = $1 AND endpoint = $2 AND key = $3',
    [tenantId, endpoint, key]
  );

  return rows[0] || null;
}

async function complete(client, id, responseStatus, responseBody) {
  await client.query(
    `UPDATE idempotency_keys
     SET state = 'completed', response_status = $2, response_body = $3
     WHERE id = $1`,
    [id, responseStatus, responseBody]
  );
}

// A rejected request drops its key rather than storing the rejection. Otherwise a
// tenant who upgrades and retries the same key is served a stale 429 from before
// the upgrade. Nothing was recorded, so re-evaluating on retry is safe.
async function release(client, id) {
  await client.query('DELETE FROM idempotency_keys WHERE id = $1', [id]);
}

module.exports = { claim, find, complete, release, UNIQUE_VIOLATION };
