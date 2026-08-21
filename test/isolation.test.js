'use strict';

// Multi-tenancy is only real if it holds when someone tries to break it. These
// tests actively attempt the crossings rather than assuming they are impossible.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pool,
  ensurePlans,
  createTenant,
  startServer,
  call,
  countUsageEvents
} = require('./helpers/testEnv');

const { fixedSimulator } = require('../src/services/workSimulator');

const simulate = fixedSimulator(0, 0);
const SMALL = { input_tokens: 100, cached_input_tokens: 0, max_output_tokens: 0 };

test.after(() => pool.end());

test("one tenant's usage never appears in another tenant's rollup", async () => {
  await ensurePlans();
  const acme = await createTenant({ name: 'Acme' });
  const globex = await createTenant({ name: 'Globex' });
  const server = await startServer({ simulate });

  try {
    for (let i = 0; i < 3; i += 1) {
      await call(server.url, { apiKey: acme.apiKey, key: `a${i}`, body: SMALL });
    }

    await call(server.url, { apiKey: globex.apiKey, key: 'g0', body: SMALL });

    const acmeUsage = await call(server.url, {
      method: 'GET',
      path: '/usage',
      apiKey: acme.apiKey
    });

    const globexUsage = await call(server.url, {
      method: 'GET',
      path: '/usage',
      apiKey: globex.apiKey
    });

    assert.equal(acmeUsage.body.used.calls, 3);
    assert.equal(acmeUsage.body.used.tokens, 300);
    assert.equal(acmeUsage.body.tenant_id, acme.id);

    assert.equal(globexUsage.body.used.calls, 1);
    assert.equal(globexUsage.body.used.tokens, 100);
    assert.equal(globexUsage.body.tenant_id, globex.id);
  } finally {
    await server.close();
  }
});

test('an idempotency key is scoped to its tenant, not shared across the system', async () => {
  await ensurePlans();
  const acme = await createTenant({ name: 'Acme' });
  const globex = await createTenant({ name: 'Globex' });
  const server = await startServer({ simulate });

  try {
    // Both tenants happen to generate the same key. If keys were global, the
    // second tenant would be handed the first tenant's response - a cross-tenant
    // data leak wearing the costume of a cache hit.
    const first = await call(server.url, { apiKey: acme.apiKey, key: 'SHARED', body: SMALL });
    const second = await call(server.url, { apiKey: globex.apiKey, key: 'SHARED', body: SMALL });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    assert.equal(first.body.tenant_id, acme.id);
    assert.equal(second.body.tenant_id, globex.id);
    assert.notEqual(first.body.tenant_id, second.body.tenant_id);

    // Two real events, one each - not one event replayed twice.
    assert.equal(await countUsageEvents(acme.id), 1);
    assert.equal(await countUsageEvents(globex.id), 1);
  } finally {
    await server.close();
  }
});

test("one tenant's spending does not consume another tenant's quota", async () => {
  await ensurePlans();
  const acme = await createTenant({ name: 'Acme' });
  const globex = await createTenant({ name: 'Globex' });
  const server = await startServer({ simulate });

  try {
    for (let i = 0; i < 5; i += 1) {
      await call(server.url, { apiKey: acme.apiKey, key: `spend-${i}`, body: SMALL });
    }

    const globexUsage = await call(server.url, {
      method: 'GET',
      path: '/usage',
      apiKey: globex.apiKey
    });

    assert.equal(globexUsage.body.used.calls, 0);
    assert.equal(globexUsage.body.used.cost_micros, 0);
    assert.equal(globexUsage.body.remaining.calls, globexUsage.body.limits.api_calls);
  } finally {
    await server.close();
  }
});

test('a revoked or unknown key reaches nothing at all', async () => {
  await ensurePlans();
  const acme = await createTenant({ name: 'Acme' });
  const server = await startServer({ simulate });

  try {
    await call(server.url, { apiKey: acme.apiKey, key: 'real', body: SMALL });

    for (const attempt of ['sk_test_forged', '', 'Bearer', acme.apiKey.slice(0, -1)]) {
      const result = await call(server.url, {
        method: 'GET',
        path: '/usage',
        apiKey: attempt || undefined
      });

      assert.equal(result.status, 401, `key ${JSON.stringify(attempt)} should not authenticate`);
    }

    // Changing one character of a real key is still not a real key.
    const nearMiss = await call(server.url, {
      apiKey: `${acme.apiKey.slice(0, -1)}X`,
      key: 'forged',
      body: SMALL
    });

    assert.equal(nearMiss.status, 401);
    assert.equal(await countUsageEvents(acme.id), 1);
  } finally {
    await server.close();
  }
});

test('the events feed is tenant-scoped and needs a key', async () => {
  await ensurePlans();
  const acme = await createTenant({ name: 'Acme' });
  const globex = await createTenant({ name: 'Globex' });
  const server = await startServer({ simulate });

  try {
    for (let i = 0; i < 2; i += 1) {
      await call(server.url, { apiKey: acme.apiKey, key: `ev-${i}`, body: SMALL });
    }

    const unauthenticated = await call(server.url, { method: 'GET', path: '/usage/events' });
    assert.equal(unauthenticated.status, 401, 'the feed must not be readable without a key');

    const mine = await call(server.url, {
      method: 'GET',
      path: '/usage/events',
      apiKey: acme.apiKey
    });

    // Two requests, each writing an api_call row and a tokens row.
    assert.equal(mine.status, 200);
    assert.equal(mine.body.events.length, 4);

    // The neighbour sees none of it. The dashboard reads this endpoint, so a leak
    // here would be a leak on screen.
    const theirs = await call(server.url, {
      method: 'GET',
      path: '/usage/events',
      apiKey: globex.apiKey
    });

    assert.equal(theirs.body.events.length, 0);
  } finally {
    await server.close();
  }
});
