'use strict';

// The heart of the capstone: a retried request must record exactly one usage
// event. These run against a real Postgres because the guarantee lives in a
// UNIQUE constraint, not in application code.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pool,
  ensurePlans,
  createTenant,
  startServer,
  call,
  countUsageEvents,
  reservationStates,
  REQUEST
} = require('./helpers/testEnv');

const { fixedSimulator } = require('../src/services/workSimulator');

// Pinned outcome, so the numbers below are exact rather than approximate.
const simulate = fixedSimulator(900, 150);

test.after(() => pool.end());

test('the same request retried records exactly one usage event', async () => {
  await ensurePlans();
  const tenant = await createTenant();
  const server = await startServer({ simulate });

  try {
    const first = await call(server.url, { apiKey: tenant.apiKey, key: 'key-1', body: REQUEST });
    const second = await call(server.url, { apiKey: tenant.apiKey, key: 'key-1', body: REQUEST });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    // The second response mirrors the first, byte for byte.
    assert.deepEqual(second.body, first.body);

    assert.equal(await countUsageEvents(tenant.id), 1);
  } finally {
    await server.close();
  }
});

test('twenty simultaneous retries still record exactly one usage event', async () => {
  await ensurePlans();
  const tenant = await createTenant();
  const server = await startServer({ simulate });

  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        call(server.url, { apiKey: tenant.apiKey, key: 'race-key', body: REQUEST })
      )
    );

    const succeeded = results.filter((r) => r.status === 200);
    const conflicted = results.filter((r) => r.status === 409);

    // Deliberately NOT asserting "1 success and 19 conflicts". That split depends
    // on timing: a duplicate arriving while the first is still in flight gets 409,
    // one arriving after it finished gets a replayed 200. Both are correct, and
    // pinning the ratio would make this test flaky under load - the worst possible
    // property for the test that guards against double-charging.
    //
    // The invariant that actually matters holds either way.
    assert.equal(succeeded.length + conflicted.length, 20, 'every response was 200 or 409');
    assert.ok(succeeded.length >= 1, 'at least one caller succeeded');

    // Every success is the same response. No caller got a second, different charge.
    for (const response of succeeded) {
      assert.deepEqual(response.body, succeeded[0].body);
    }

    // The claim being proved: one event, not twenty.
    assert.equal(await countUsageEvents(tenant.id), 1);
    assert.deepEqual(await reservationStates(tenant.id), { committed: 1 });
  } finally {
    await server.close();
  }
});

test('the same key with a different body is refused with 422, not silently replayed', async () => {
  await ensurePlans();
  const tenant = await createTenant();
  const server = await startServer({ simulate });

  try {
    const first = await call(server.url, { apiKey: tenant.apiKey, key: 'key-2', body: REQUEST });
    assert.equal(first.status, 200);

    const different = await call(server.url, {
      apiKey: tenant.apiKey,
      key: 'key-2',
      body: { ...REQUEST, max_output_tokens: 999 }
    });

    assert.equal(different.status, 422);
    assert.equal(different.body.code, 'idempotency_key_reused');

    // Still one event: the mismatched request was refused, not recorded.
    assert.equal(await countUsageEvents(tenant.id), 1);
  } finally {
    await server.close();
  }
});

test('key order in the body does not change the fingerprint', async () => {
  await ensurePlans();
  const tenant = await createTenant();
  const server = await startServer({ simulate });

  try {
    await call(server.url, {
      apiKey: tenant.apiKey,
      key: 'key-3',
      body: { input_tokens: 10, cached_input_tokens: 20, max_output_tokens: 30 }
    });

    // Same request, keys written in a different order. A client that does not
    // preserve key order must not be told it sent a different request.
    const reordered = await call(server.url, {
      apiKey: tenant.apiKey,
      key: 'key-3',
      body: { max_output_tokens: 30, input_tokens: 10, cached_input_tokens: 20 }
    });

    assert.equal(reordered.status, 200);
    assert.equal(await countUsageEvents(tenant.id), 1);
  } finally {
    await server.close();
  }
});

test('different keys record different events', async () => {
  await ensurePlans();
  const tenant = await createTenant();
  const server = await startServer({ simulate });

  try {
    await call(server.url, { apiKey: tenant.apiKey, key: 'a', body: REQUEST });
    await call(server.url, { apiKey: tenant.apiKey, key: 'b', body: REQUEST });

    assert.equal(await countUsageEvents(tenant.id), 2);
  } finally {
    await server.close();
  }
});

test('a request without an idempotency key is rejected before anything is recorded', async () => {
  await ensurePlans();
  const tenant = await createTenant();
  const server = await startServer({ simulate });

  try {
    const result = await call(server.url, { apiKey: tenant.apiKey, body: REQUEST });

    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'idempotency_key_required');
    assert.equal(await countUsageEvents(tenant.id), 0);
  } finally {
    await server.close();
  }
});

test('the surplus reservation is released once the actual usage is known', async () => {
  await ensurePlans();
  const tenant = await createTenant();
  const server = await startServer({ simulate });

  try {
    const result = await call(server.url, { apiKey: tenant.apiKey, key: 'key-4', body: REQUEST });

    assert.equal(result.status, 200);

    // Reserved worst case: 1200 + 8000 + 2000 output + 2000 reasoning = 13,200
    // Actually used:       1200 + 8000 +  900 output +  150 reasoning = 10,250
    assert.equal(result.body.reserved.tokens, 13_200);
    assert.equal(result.body.used.tokens, 10_250);
    assert.equal(result.body.released.tokens, 2_950);

    // If these were ever equal the release path would never run.
    assert.notEqual(result.body.reserved.tokens, result.body.used.tokens);
  } finally {
    await server.close();
  }
});

test('an unknown API key gets 401 and records nothing', async () => {
  await ensurePlans();
  const tenant = await createTenant();
  const server = await startServer({ simulate });

  try {
    const result = await call(server.url, { apiKey: 'sk_test_nope', key: 'x', body: REQUEST });

    assert.equal(result.status, 401);
    assert.equal(await countUsageEvents(tenant.id), 0);
  } finally {
    await server.close();
  }
});

test('a malformed body is a clean 400, never a 500', async () => {
  await ensurePlans();
  const tenant = await createTenant();
  const server = await startServer({ simulate });

  try {
    const cases = [
      { input_tokens: -1, cached_input_tokens: 0, max_output_tokens: 10 },
      { input_tokens: 1.5, cached_input_tokens: 0, max_output_tokens: 10 },
      { input_tokens: 'lots', cached_input_tokens: 0, max_output_tokens: 10 },
      { cached_input_tokens: 0, max_output_tokens: 10 },
      {}
    ];

    for (const [index, body] of cases.entries()) {
      const result = await call(server.url, {
        apiKey: tenant.apiKey,
        key: `bad-${index}`,
        body
      });

      assert.equal(result.status, 400, `case ${index} returned ${result.status}`);
      assert.equal(result.body.code, 'invalid_request');
    }

    assert.equal(await countUsageEvents(tenant.id), 0);
  } finally {
    await server.close();
  }
});
