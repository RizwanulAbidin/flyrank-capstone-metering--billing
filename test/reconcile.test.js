'use strict';

// The background job. Stripe is faked here on purpose - the point is to prove
// this database gets corrected when it disagrees with Stripe, not to prove that
// Stripe's SDK works.

const test = require('node:test');
const assert = require('node:assert/strict');

const { pool, ensurePlans, createTenant, startServer, call } = require('./helpers/testEnv');
const { reconcile } = require('../src/jobs/reconcile');
const tenantRepo = require('../src/repositories/tenantRepo');
const { fixedSimulator } = require('../src/services/workSimulator');

const simulate = fixedSimulator(0, 0);
const SMALL = { input_tokens: 100, cached_input_tokens: 0, max_output_tokens: 0 };

// Minimal stand-in for stripe.subscriptions.list, keyed by customer id.
function fakeStripe(byCustomer) {
  return {
    subscriptions: {
      list: async ({ customer }) => ({ data: byCustomer[customer] || [] })
    }
  };
}

async function linkToStripe(tenantId, customerId) {
  await pool.query('UPDATE tenants SET stripe_customer_id = $2 WHERE id = $1', [
    tenantId,
    customerId
  ]);
}

async function heldReservations(tenantId) {
  const { rows } = await pool.query(
    "SELECT state FROM reservations WHERE tenant_id = $1 AND state = 'held'",
    [tenantId]
  );

  return rows.length;
}

async function insertReservation(tenantId, expiresSql) {
  await pool.query(
    `INSERT INTO reservations
       (tenant_id, estimated_calls, estimated_tokens, estimated_cost_micros,
        state, billing_period, expires_at)
     VALUES ($1, 1, 5000, 1000, 'held', date_trunc('month', now())::date, ${expiresSql})`,
    [tenantId]
  );
}

test.after(() => pool.end());

test('a tenant Stripe says is paying, but we have as free, is corrected to pro', async () => {
  await ensurePlans();
  const tenant = await createTenant({ plan: 'free' });
  const customerId = `cus_missed_${tenant.id.slice(0, 8)}`;
  await linkToStripe(tenant.id, customerId);

  // The lost-webhook scenario exactly: the customer paid, Stripe knows, our
  // database never heard about it.
  const stripeClient = fakeStripe({
    [customerId]: [{ id: `sub_${tenant.id.slice(0, 8)}`, status: 'active' }]
  });

  const report = await reconcile({ stripeClient, tenantIds: [tenant.id] });

  const after = await tenantRepo.findById(pool, tenant.id);
  assert.equal(after.plan_code, 'pro');
  assert.equal(after.subscription_status, 'active');

  const entry = report.drift.find((d) => d.tenant_id === tenant.id);
  assert.ok(entry, 'the correction must appear in the report');
  assert.deepEqual(entry.was, { plan: 'free', status: 'active' });
  assert.deepEqual(entry.now, { plan: 'pro', status: 'active' });
});

test('a tenant whose subscription Stripe has cancelled is downgraded to free', async () => {
  await ensurePlans();
  const tenant = await createTenant({ plan: 'pro' });
  const customerId = `cus_gone_${tenant.id.slice(0, 8)}`;
  await linkToStripe(tenant.id, customerId);

  // No live subscription at Stripe - a cancellation whose webhook we missed.
  const report = await reconcile({
    stripeClient: fakeStripe({ [customerId]: [] }),
    tenantIds: [tenant.id]
  });

  const after = await tenantRepo.findById(pool, tenant.id);
  assert.equal(after.plan_code, 'free');
  assert.equal(after.subscription_status, 'canceled');
  assert.ok(report.drift.some((d) => d.tenant_id === tenant.id));
});

test('a tenant already in agreement with Stripe is left alone', async () => {
  await ensurePlans();
  const tenant = await createTenant({ plan: 'pro' });
  const customerId = `cus_ok_${tenant.id.slice(0, 8)}`;
  await linkToStripe(tenant.id, customerId);

  const report = await reconcile({
    stripeClient: fakeStripe({
      [customerId]: [{ id: `sub_ok_${tenant.id.slice(0, 8)}`, status: 'active' }]
    }),
    tenantIds: [tenant.id]
  });

  assert.equal(
    report.drift.some((d) => d.tenant_id === tenant.id),
    false
  );
  assert.equal((await tenantRepo.findById(pool, tenant.id)).plan_code, 'pro');
});

test('past_due at Stripe is mirrored, and then blocks billable requests', async () => {
  await ensurePlans();
  const tenant = await createTenant({ plan: 'pro' });
  const customerId = `cus_pd_${tenant.id.slice(0, 8)}`;
  await linkToStripe(tenant.id, customerId);

  await reconcile({
    stripeClient: fakeStripe({
      [customerId]: [{ id: `sub_pd_${tenant.id.slice(0, 8)}`, status: 'past_due' }]
    }),
    tenantIds: [tenant.id]
  });

  assert.equal((await tenantRepo.findById(pool, tenant.id)).subscription_status, 'past_due');

  const server = await startServer({ simulate });

  try {
    const blocked = await call(server.url, { apiKey: tenant.apiKey, key: 'pd-1', body: SMALL });
    assert.equal(blocked.status, 402);
  } finally {
    await server.close();
  }
});

test('one tenant failing does not abandon the rest of the run', async () => {
  await ensurePlans();
  const broken = await createTenant({ plan: 'free' });
  const fine = await createTenant({ plan: 'free' });
  const brokenCustomer = `cus_boom_${broken.id.slice(0, 8)}`;
  const fineCustomer = `cus_fine_${fine.id.slice(0, 8)}`;

  await linkToStripe(broken.id, brokenCustomer);
  await linkToStripe(fine.id, fineCustomer);

  const stripeClient = {
    subscriptions: {
      list: async ({ customer }) => {
        if (customer === brokenCustomer) {
          throw new Error('Stripe is having a bad day');
        }

        return { data: [{ id: `sub_${fine.id.slice(0, 8)}`, status: 'active' }] };
      }
    }
  };

  const report = await reconcile({ stripeClient, tenantIds: [broken.id, fine.id] });

  assert.ok(
    report.errors.some((e) => e.tenant_id === broken.id),
    'the failure is reported'
  );
  assert.equal(
    (await tenantRepo.findById(pool, fine.id)).plan_code,
    'pro',
    'the healthy tenant was still reconciled'
  );
});

test('a reservation left held past its expiry is released', async () => {
  await ensurePlans();
  const tenant = await createTenant({ plan: 'free' });

  // A process that died between reserve and commit.
  await insertReservation(tenant.id, "now() - interval '10 minutes'");
  assert.equal(await heldReservations(tenant.id), 1, 'the stale reservation exists');

  const report = await reconcile({ stripeClient: fakeStripe({}), tenantIds: [] });

  assert.ok(report.expired_reservations >= 1);
  assert.equal(await heldReservations(tenant.id), 0, 'the quota it was holding is given back');
});

test('a reservation still inside its window is left alone', async () => {
  await ensurePlans();
  const tenant = await createTenant({ plan: 'free' });

  await insertReservation(tenant.id, "now() + interval '5 minutes'");

  await reconcile({ stripeClient: fakeStripe({}), tenantIds: [] });

  assert.equal(
    await heldReservations(tenant.id),
    1,
    'an in-flight request must keep its reservation'
  );
});

test('the report is honest about what it did', async () => {
  await ensurePlans();
  const report = await reconcile({ stripeClient: fakeStripe({}), tenantIds: [] });

  for (const key of [
    'started_at',
    'expired_reservations',
    'tenants_checked',
    'drift_corrected',
    'drift',
    'errors',
    'duration_ms'
  ]) {
    assert.ok(key in report, `report is missing ${key}`);
  }

  assert.equal(report.drift_corrected, report.drift.length);
  assert.equal(typeof report.duration_ms, 'number');
});
