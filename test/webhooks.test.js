'use strict';

// Webhook verification and replay protection, with no Stripe account involved.
//
// A Stripe signature is HMAC-SHA256 over "timestamp.rawBody" keyed by the whsec_
// secret, so a correctly-signed event can be built locally. That makes these
// tests deterministic, offline, and runnable by anyone who clones the repo -
// which is exactly what a test guarding a payment path should be.

const test = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');

const { pool, ensurePlans, createTenant, startServer } = require('./helpers/testEnv');
const tenantRepo = require('../src/repositories/tenantRepo');
const webhookRepo = require('../src/repositories/webhookRepo');

const SECRET = process.env.STRIPE_WEBHOOK_SECRET;

let eventCounter = 0;

function uniqueEventId() {
  eventCounter += 1;
  return `evt_test_${Date.now()}_${process.pid}_${eventCounter}`;
}

function buildEvent(type, object, id = uniqueEventId()) {
  return { id, object: 'event', type, api_version: '2026-01-01', data: { object } };
}

async function postWebhook(url, event, { secret = SECRET, tamper = false, header } = {}) {
  const payload = JSON.stringify(event);

  const signature =
    header !== undefined
      ? header
      : Stripe.webhooks.generateTestHeaderString({ payload, secret });

  const response = await fetch(`${url}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signature === null ? {} : { 'Stripe-Signature': signature })
    },
    // Signed one payload, send a different one. The signature is still perfectly
    // valid - for the message that was NOT sent.
    body: tamper ? payload.replace('"pro"', '"free"') + ' ' : payload
  });

  return { status: response.status, body: await response.json().catch(() => null) };
}

test.after(() => pool.end());

test('a correctly signed checkout.session.completed upgrades the tenant to pro', async () => {
  await ensurePlans();
  const tenant = await createTenant({ plan: 'free' });
  const server = await startServer();

  try {
    const before = await tenantRepo.findById(pool, tenant.id);
    assert.equal(before.plan_code, 'free');

    const event = buildEvent('checkout.session.completed', {
      id: 'cs_test_1',
      customer: `cus_test_${tenant.id.slice(0, 8)}`,
      subscription: `sub_test_${tenant.id.slice(0, 8)}`,
      metadata: { tenant_id: tenant.id }
    });

    const result = await postWebhook(server.url, event);

    assert.equal(result.status, 200);
    assert.equal(result.body.duplicate, false);
    assert.equal(result.body.applied, 'upgraded to pro');

    const after = await tenantRepo.findById(pool, tenant.id);
    assert.equal(after.plan_code, 'pro');
    assert.equal(after.subscription_status, 'active');

    // The new limits are live immediately.
    assert.equal(after.api_call_limit, 50_000);
    assert.equal(after.token_limit, 5_000_000);
  } finally {
    await server.close();
  }
});

test('a forged signature is rejected with 400 and changes nothing', async () => {
  await ensurePlans();
  const tenant = await createTenant({ plan: 'free' });
  const server = await startServer();

  try {
    const event = buildEvent('checkout.session.completed', {
      id: 'cs_forged',
      customer: 'cus_forged',
      subscription: 'sub_forged',
      metadata: { tenant_id: tenant.id }
    });

    const result = await postWebhook(server.url, event, { secret: 'whsec_wrong_secret' });

    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'invalid_signature');

    const after = await tenantRepo.findById(pool, tenant.id);
    assert.equal(after.plan_code, 'free', 'a forged event must not upgrade anyone');
    assert.equal(await webhookRepo.wasProcessed(pool, event.id), false);
  } finally {
    await server.close();
  }
});

test('a tampered payload with a real signature is rejected', async () => {
  await ensurePlans();
  const tenant = await createTenant({ plan: 'free' });
  const server = await startServer();

  try {
    const event = buildEvent('checkout.session.completed', {
      id: 'cs_tampered',
      customer: 'cus_tampered',
      subscription: 'sub_tampered',
      metadata: { tenant_id: tenant.id }
    });

    // Signature computed over the original bytes, body altered afterwards. This is
    // the attack the signature exists to stop.
    const result = await postWebhook(server.url, event, { tamper: true });

    assert.equal(result.status, 400);
    assert.equal((await tenantRepo.findById(pool, tenant.id)).plan_code, 'free');
  } finally {
    await server.close();
  }
});

test('a missing signature header is rejected with 400', async () => {
  await ensurePlans();
  const tenant = await createTenant({ plan: 'free' });
  const server = await startServer();

  try {
    const event = buildEvent('checkout.session.completed', {
      id: 'cs_nosig',
      customer: 'cus_nosig',
      metadata: { tenant_id: tenant.id }
    });

    const result = await postWebhook(server.url, event, { header: null });

    assert.equal(result.status, 400);
    assert.equal((await tenantRepo.findById(pool, tenant.id)).plan_code, 'free');
  } finally {
    await server.close();
  }
});

test('the same event delivered twice is processed exactly once', async () => {
  await ensurePlans();
  const tenant = await createTenant({ plan: 'free' });
  const server = await startServer();

  try {
    const event = buildEvent('checkout.session.completed', {
      id: 'cs_replay',
      customer: `cus_replay_${tenant.id.slice(0, 8)}`,
      subscription: `sub_replay_${tenant.id.slice(0, 8)}`,
      metadata: { tenant_id: tenant.id }
    });

    const first = await postWebhook(server.url, event);
    const second = await postWebhook(server.url, event);

    assert.equal(first.status, 200);
    assert.equal(first.body.duplicate, false);
    assert.equal(first.body.applied, 'upgraded to pro');

    // Acknowledged, so Stripe stops retrying - but applied nothing a second time.
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(second.body.applied, null);
  } finally {
    await server.close();
  }
});

test('ten simultaneous deliveries of one event are processed exactly once', async () => {
  await ensurePlans();
  const tenant = await createTenant({ plan: 'free' });
  const server = await startServer();

  try {
    const event = buildEvent('checkout.session.completed', {
      id: 'cs_race',
      customer: `cus_race_${tenant.id.slice(0, 8)}`,
      subscription: `sub_race_${tenant.id.slice(0, 8)}`,
      metadata: { tenant_id: tenant.id }
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => postWebhook(server.url, event))
    );

    const applied = results.filter((r) => r.body.duplicate === false);

    assert.equal(results.filter((r) => r.status === 200).length, 10);
    assert.equal(applied.length, 1, 'exactly one delivery may apply the event');
  } finally {
    await server.close();
  }
});

test('subscription.deleted downgrades the tenant back to free', async () => {
  await ensurePlans();
  const tenant = await createTenant({ plan: 'free' });
  const server = await startServer();

  try {
    const customerId = `cus_del_${tenant.id.slice(0, 8)}`;

    await postWebhook(
      server.url,
      buildEvent('checkout.session.completed', {
        id: 'cs_del',
        customer: customerId,
        subscription: `sub_del_${tenant.id.slice(0, 8)}`,
        metadata: { tenant_id: tenant.id }
      })
    );

    assert.equal((await tenantRepo.findById(pool, tenant.id)).plan_code, 'pro');

    const result = await postWebhook(
      server.url,
      buildEvent('customer.subscription.deleted', {
        id: `sub_del_${tenant.id.slice(0, 8)}`,
        customer: customerId,
        status: 'canceled'
      })
    );

    assert.equal(result.body.applied, 'downgraded to free');

    const after = await tenantRepo.findById(pool, tenant.id);
    assert.equal(after.plan_code, 'free');
    assert.equal(after.subscription_status, 'canceled');
  } finally {
    await server.close();
  }
});

test('a past_due subscription blocks billable requests', async () => {
  await ensurePlans();
  const tenant = await createTenant({ plan: 'free' });
  const server = await startServer();

  try {
    const customerId = `cus_pd_${tenant.id.slice(0, 8)}`;

    await postWebhook(
      server.url,
      buildEvent('checkout.session.completed', {
        id: 'cs_pd',
        customer: customerId,
        subscription: `sub_pd_${tenant.id.slice(0, 8)}`,
        metadata: { tenant_id: tenant.id }
      })
    );

    await postWebhook(
      server.url,
      buildEvent('customer.subscription.updated', {
        id: `sub_pd_${tenant.id.slice(0, 8)}`,
        customer: customerId,
        status: 'past_due'
      })
    );

    const after = await tenantRepo.findById(pool, tenant.id);
    assert.equal(after.subscription_status, 'past_due');

    // And the metering path refuses on the strength of it.
    const blocked = await fetch(`${server.url}/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenant.apiKey}`,
        'Idempotency-Key': 'after-past-due'
      },
      body: JSON.stringify({ input_tokens: 10, cached_input_tokens: 0, max_output_tokens: 0 })
    });

    assert.equal(blocked.status, 402);
  } finally {
    await server.close();
  }
});

test('an event type we do not handle is acknowledged, not retried forever', async () => {
  await ensurePlans();
  const server = await startServer();

  try {
    const event = buildEvent('invoice.payment_succeeded', { id: 'in_test_1' });
    const result = await postWebhook(server.url, event);

    assert.equal(result.status, 200);
    assert.equal(result.body.applied, 'ignored:invoice.payment_succeeded');
  } finally {
    await server.close();
  }
});

test('an event for an unknown Stripe customer is ignored, not an error', async () => {
  await ensurePlans();
  const server = await startServer();

  try {
    const event = buildEvent('customer.subscription.updated', {
      id: 'sub_ghost',
      customer: 'cus_never_seen',
      status: 'active'
    });

    const result = await postWebhook(server.url, event);

    assert.equal(result.status, 200);
    assert.equal(result.body.applied, 'ignored:unknown customer');
  } finally {
    await server.close();
  }
});
