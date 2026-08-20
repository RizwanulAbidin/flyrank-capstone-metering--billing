'use strict';

// The metering path. Four steps, each with its own transaction, in this order for
// reasons that matter:
//
//   1. CLAIM   the idempotency key, and commit immediately, so a concurrent retry
//              can see it. Holding it open would make duplicates block instead of
//              being told the truth.
//   2. RESERVE a conservative estimate, under a per-tenant row lock, so two
//              simultaneous requests cannot both be granted the same headroom.
//   3. WORK    outside any transaction - it is the slow part, and holding a
//              database lock across it would serialise the whole tenant.
//   4. COMMIT  the actual usage, release the surplus, store the response.

const { pool, withTransaction } = require('../db/pool');
const { ApiError } = require('../errors');
const { now, billingPeriod } = require('../clock');
const tenantRepo = require('../repositories/tenantRepo');
const idempotencyRepo = require('../repositories/idempotencyRepo');
const reservationRepo = require('../repositories/reservationRepo');
const usageRepo = require('../repositories/usageRepo');
const pricing = require('./PricingService');
const quota = require('./QuotaService');
const { simulateWork } = require('./workSimulator');

const ENDPOINT = 'POST /generate';
const RESERVATION_TTL_MS = 5 * 60 * 1000;

async function record({ tenant, key, body, simulate = simulateWork }) {
  const requestFingerprint = require('../fingerprint').fingerprint(body);

  // ---- 1. claim the key -------------------------------------------------
  const claim = await withTransaction((client) =>
    idempotencyRepo.claim(client, {
      tenantId: tenant.id,
      endpoint: ENDPOINT,
      key,
      requestFingerprint
    })
  );

  if (!claim.claimed) {
    return replayOrRefuse({ tenant, key, requestFingerprint });
  }

  const idempotencyKeyId = claim.row.id;

  // ---- 2. reserve -------------------------------------------------------
  const estimate = pricing.estimate(body);
  const at = now();
  const period = billingPeriod(at);

  let reservation;

  try {
    reservation = await withTransaction(async (client) => {
      // Serialises reserves for THIS tenant only. Different tenants proceed
      // in parallel; two requests from the same tenant queue here.
      const locked = await tenantRepo.lockForUpdate(client, tenant.id);

      const committed = await usageRepo.committedTotals(client, tenant.id, period);
      const held = await reservationRepo.heldTotals(client, tenant.id, period);

      const decision = quota.check({
        plan: locked,
        subscriptionStatus: locked.subscription_status,
        committed,
        held,
        requested: { calls: estimate.calls, tokens: estimate.tokens, cost_micros: estimate.cost_micros }
      });

      if (!decision.allowed) {
        throw decision.error;
      }

      return reservationRepo.insertHeld(client, {
        tenantId: tenant.id,
        idempotencyKeyId,
        estimatedCalls: estimate.calls,
        estimatedTokens: estimate.tokens,
        estimatedCostMicros: estimate.cost_micros,
        billingPeriod: period,
        expiresAt: new Date(at.getTime() + RESERVATION_TTL_MS)
      });
    });
  } catch (error) {
    // Rejected: drop the key so a retry after an upgrade is re-evaluated rather
    // than served this rejection forever. Nothing was recorded, so this is safe.
    await withTransaction((client) => idempotencyRepo.release(client, idempotencyKeyId));
    throw error;
  }

  // ---- 3. do the work ---------------------------------------------------
  const produced = simulate(body);

  const used = pricing.actual({
    input_tokens: body.input_tokens,
    cached_input_tokens: body.cached_input_tokens,
    output_tokens: produced.output_tokens,
    reasoning_tokens: produced.reasoning_tokens
  });

  // ---- 4. commit --------------------------------------------------------
  const response = await withTransaction(async (client) => {
    await usageRepo.insertEvent(client, {
      tenantId: tenant.id,
      usageType: 'api_call',
      quantity: 1,
      costMicros: used.call_cost_micros,
      breakdown: null,
      reservationId: reservation.id,
      idempotencyKeyId,
      billingPeriod: period,
      occurredAt: at
    });

    await usageRepo.insertEvent(client, {
      tenantId: tenant.id,
      usageType: 'tokens',
      quantity: used.tokens,
      costMicros: used.token_cost_micros,
      breakdown: used.breakdown,
      reservationId: reservation.id,
      idempotencyKeyId,
      billingPeriod: period,
      occurredAt: at
    });

    await reservationRepo.setState(client, reservation.id, 'committed');

    const payload = {
      idempotency_key: key,
      tenant_id: tenant.id,
      billing_period: period,
      reserved: {
        tokens: estimate.tokens,
        cost_micros: estimate.cost_micros
      },
      used: {
        tokens: used.tokens,
        cost_micros: used.cost_micros,
        breakdown: used.breakdown.tokens
      },
      released: {
        tokens: estimate.tokens - used.tokens,
        cost_micros: estimate.cost_micros - used.cost_micros
      }
    };

    await idempotencyRepo.complete(client, idempotencyKeyId, 200, payload);

    return payload;
  });

  return { status: 200, body: response, replayed: false };
}

// Someone else holds this key. Three outcomes, all of them honest.
async function replayOrRefuse({ tenant, key, requestFingerprint }) {
  const existing = await withTransaction((client) =>
    idempotencyRepo.find(client, { tenantId: tenant.id, endpoint: ENDPOINT, key })
  );

  if (!existing) {
    // The holder rolled back between our failed insert and this read. Telling the
    // client to retry is the honest answer.
    throw new ApiError(409, 'idempotency_key_in_progress', 'Retry this request');
  }

  if (existing.request_fingerprint !== requestFingerprint) {
    // Per the IETF idempotency-key draft: the client has a bug. Silently replaying
    // an unrelated response would hide it.
    throw new ApiError(
      422,
      'idempotency_key_reused',
      'This idempotency key was already used with a different request body'
    );
  }

  if (existing.state === 'in_progress') {
    throw new ApiError(
      409,
      'idempotency_key_in_progress',
      'A request with this idempotency key is still being processed'
    );
  }

  return { status: existing.response_status, body: existing.response_body, replayed: true };
}

async function usageFor(tenant, at = now()) {
  const period = billingPeriod(at);

  // Two plain reads. Deliberately not wrapped in a transaction: a read-only
  // rollup does not need one, and every avoidable connection held is one fewer
  // available to the metering path.
  const committed = await usageRepo.committedTotals(pool, tenant.id, period);
  const held = await reservationRepo.heldTotals(pool, tenant.id, period);

  return {
    tenant_id: tenant.id,
    plan: tenant.plan_code,
    billing_period: period,
    limits: {
      api_calls: tenant.api_call_limit,
      tokens: tenant.token_limit,
      spend_cap_micros: tenant.spend_cap_micros
    },
    used: committed,
    held,
    remaining: quota.remaining(tenant, committed, held)
  };
}

module.exports = { record, usageFor, ENDPOINT, RESERVATION_TTL_MS };
