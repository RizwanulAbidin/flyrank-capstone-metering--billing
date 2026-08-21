'use strict';

// The background job. Runs on a schedule, off the request path, and exists
// because webhook delivery is not guaranteed.
//
// This is not a theoretical concern. On the first real Checkout of this project
// the `checkout.session.completed` event never arrived: the Stripe CLI's
// websocket dropped and reconnected, and events emitted in the gap were silently
// lost. The customer had paid, Stripe knew, and this database disagreed - and
// nothing in the metering path would ever have noticed.
//
// Two jobs:
//   1. release reservations whose owner died between reserve and commit
//   2. compare every linked tenant against Stripe's view and correct the drift
//
// Stripe is the authority on payment. Where the two disagree, Stripe wins.

const fs = require('node:fs/promises');
const path = require('node:path');

const { pool, withTransaction } = require('../db/pool');
const { now } = require('../clock');
const tenantRepo = require('../repositories/tenantRepo');
const subscriptionRepo = require('../repositories/subscriptionRepo');
const reservationRepo = require('../repositories/reservationRepo');
const { mapSubscriptionStatus, toDate } = require('../services/StripeService');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output');
const RETRY_DELAY_MS = 1_000;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Not every error has a usable .message. An AggregateError - which is what
// node-postgres throws when it cannot reach the database at all - has an empty
// one, so a naive `error.message` produces the alert "ALERT reconcile:" and
// tells the operator nothing. An alert that says nothing is worse than no alert,
// because it looks like it worked.
function describeError(error) {
  const parts = [error.name, error.code, error.message].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : String(error);
}

// Same rule as the A9 scraper, in Stripe's vocabulary. A network blip or a 5xx is
// worth one more try; a 404 or a 400 is a clear answer and asking again just
// makes us a nuisance.
function isRetryableStripeError(error) {
  if (error.type === 'StripeConnectionError' || error.type === 'StripeAPIError') {
    return true;
  }

  if (error.type === 'StripeRateLimitError' || error.statusCode === 429) {
    return true;
  }

  return typeof error.statusCode === 'number' && error.statusCode >= 500;
}

async function withOneRetry(work) {
  try {
    return await work();
  } catch (error) {
    if (!isRetryableStripeError(error)) {
      throw error;
    }

    await sleep(RETRY_DELAY_MS);
    return work();
  }
}

function defaultStripeClient() {
  const Stripe = require('stripe');

  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY must be set in .env');
  }

  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// A crashed process must not hold quota forever. Anything still 'held' past its
// expiry is released so the tenant gets that headroom back.
async function releaseExpiredReservations(at) {
  return withTransaction((client) => reservationRepo.expireStale(client, at));
}

// What Stripe thinks this customer's plan and status are.
async function stripeViewOf(stripeClient, stripeCustomerId) {
  const subscriptions = await withOneRetry(() =>
    stripeClient.subscriptions.list({
      customer: stripeCustomerId,
      status: 'all',
      limit: 10
    })
  );

  const live = subscriptions.data.find(
    (s) => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due'
  );

  if (!live) {
    return { planCode: 'free', status: 'canceled', subscription: null };
  }

  return {
    planCode: mapSubscriptionStatus(live.status) === 'canceled' ? 'free' : 'pro',
    status: mapSubscriptionStatus(live.status),
    subscription: live
  };
}

async function reconcileTenant(stripeClient, tenant) {
  const view = await stripeViewOf(stripeClient, tenant.stripe_customer_id);

  const drifted =
    view.planCode !== tenant.plan_code || view.status !== tenant.subscription_status;

  if (!drifted) {
    return { tenant_id: tenant.id, drifted: false };
  }

  await withTransaction(async (client) => {
    await tenantRepo.setPlan(client, tenant.id, view.planCode, view.status);

    if (view.subscription) {
      await subscriptionRepo.upsert(client, {
        tenantId: tenant.id,
        stripeSubscriptionId: view.subscription.id,
        status: view.status,
        currentPeriodStart: toDate(view.subscription.current_period_start),
        currentPeriodEnd: toDate(view.subscription.current_period_end)
      });
    }
  });

  return {
    tenant_id: tenant.id,
    drifted: true,
    was: { plan: tenant.plan_code, status: tenant.subscription_status },
    now: { plan: view.planCode, status: view.status }
  };
}

// `tenantIds` scopes a run to specific tenants. Operationally that is useful for
// re-checking one customer after an incident; in the tests it is essential,
// because this job is global by nature and an unscoped run would reconcile - and
// rewrite - tenants belonging to every other test file.
async function reconcile({ stripeClient, at = now(), tenantIds = null } = {}) {
  const client = stripeClient || defaultStripeClient();
  const startedMs = Date.now();

  const report = {
    started_at: at.toISOString(),
    expired_reservations: 0,
    tenants_checked: 0,
    drift_corrected: 0,
    drift: [],
    errors: [],
    duration_ms: 0
  };

  report.expired_reservations = await releaseExpiredReservations(at);

  const all = await tenantRepo.listWithStripeCustomer(pool);
  const tenants = tenantIds ? all.filter((t) => tenantIds.includes(t.id)) : all;
  report.tenants_checked = tenants.length;

  for (const tenant of tenants) {
    // One tenant failing must not abandon the rest - the same rule the scraper
    // in A9 followed for one bad page.
    try {
      const result = await reconcileTenant(client, tenant);

      if (result.drifted) {
        report.drift_corrected += 1;
        report.drift.push(result);
      }
    } catch (error) {
      report.errors.push({ tenant_id: tenant.id, reason: describeError(error) });
    }
  }

  report.duration_ms = Date.now() - startedMs;

  await writeReport(report);
  await raiseAlertIfNeeded(report);

  return report;
}

// A job that reports nothing can fail silently for weeks. Same habit as the run
// report in A9: write the numbers down every time, whether or not anyone reads
// them today.
async function writeReport(report) {
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.writeFile(
      path.join(OUTPUT_DIR, 'reconcile-report.json'),
      JSON.stringify(report, null, 2),
      'utf8'
    );
  } catch (error) {
    // Never let bookkeeping sink the run that already did the useful work.
    console.error(`reconcile: could not write report - ${describeError(error)}`);
  }
}

// The failure alert. Three escalating signals, because different operators watch
// different things: a marked log line, a non-zero exit for whatever scheduler
// invoked us, and an optional POST for a real alerting channel.
async function raiseAlertIfNeeded(report) {
  if (report.errors.length === 0) {
    return;
  }

  console.error(
    `ALERT reconcile: ${report.errors.length} of ${report.tenants_checked} tenants could not be checked`
  );

  for (const failure of report.errors.slice(0, 5)) {
    console.error(`ALERT   ${failure.tenant_id}: ${failure.reason}`);
  }

  if (!process.env.ALERT_WEBHOOK_URL) {
    return;
  }

  try {
    await fetch(process.env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job: 'reconcile', report }),
      signal: AbortSignal.timeout(5_000)
    });
  } catch (error) {
    console.error(`ALERT reconcile: could not deliver alert - ${describeError(error)}`);
  }
}

// Runs forever on an interval. Used by the `reconcile` service in compose.yaml.
// Kept in-process rather than as a shell `while true` loop so a failure is
// visible as an alert rather than as a container that quietly restarts.
async function loop(intervalMs) {
  console.log(`reconcile: scheduled every ${Math.round(intervalMs / 1000)}s`);

  for (;;) {
    try {
      const report = await reconcile();
      console.log(
        `reconcile: checked ${report.tenants_checked}, corrected ${report.drift_corrected}, ` +
          `expired ${report.expired_reservations}, errors ${report.errors.length}`
      );
    } catch (error) {
      console.error(`ALERT reconcile: run failed entirely - ${describeError(error)}`);
    }

    await sleep(intervalMs);
  }
}

if (require.main === module) {
  const intervalMs = Number(process.env.RECONCILE_INTERVAL_MS) || DEFAULT_INTERVAL_MS;

  if (process.argv.includes('--loop')) {
    loop(intervalMs).catch(async (error) => {
      console.error('reconcile loop died:', describeError(error));
      await pool.end();
      process.exit(1);
    });
  } else {
    reconcile()
      .then(async (report) => {
        console.log(JSON.stringify(report, null, 2));
        await pool.end();
        // Non-zero so cron, systemd or a compose healthcheck notices. The work
        // that succeeded is still committed; this only reports that some of it
        // did not.
        process.exit(report.errors.length > 0 ? 1 : 0);
      })
      .catch(async (error) => {
        console.error(`ALERT reconcile: ${describeError(error)}`);
        await pool.end();
        process.exit(1);
      });
  }
}

module.exports = { reconcile, releaseExpiredReservations, isRetryableStripeError, describeError, loop };
