'use strict';

const path = require('node:path');

const express = require('express');
const { z } = require('zod');

const { ApiError } = require('../errors');
const { authenticate } = require('./auth');
const meter = require('../services/MeterService');
const usageRepo = require('../repositories/usageRepo');
const { pool } = require('../db/pool');
const stripeService = require('../services/StripeService');
const webhookService = require('../services/WebhookService');

// Validation at the boundary: bad input becomes a clean 400, never a 500 from
// somewhere deep in the money math.
const GenerateBody = z.object({
  input_tokens: z.int().min(0).max(1_000_000),
  cached_input_tokens: z.int().min(0).max(1_000_000),
  max_output_tokens: z.int().min(0).max(100_000)
});

function buildApp({ simulate } = {}) {
  const app = express();

  // ---------------------------------------------------------------------
  // The Stripe webhook MUST be registered before express.json(), and must use
  // express.raw().
  //
  // Stripe signs the exact bytes it sent. express.json() consumes the stream,
  // parses it, and throws the raw bytes away - and re-serialising req.body does
  // not reliably reproduce them (key order, whitespace, unicode escaping). The
  // signature would then fail for every genuine event, which looks exactly like
  // a wrong secret and is the single most common Stripe integration bug.
  // ---------------------------------------------------------------------
  app.post(
    '/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    async (req, res, next) => {
      let event;

      try {
        event = stripeService.constructEvent(req.body, req.headers['stripe-signature']);
      } catch (error) {
        // Verify first, ask questions never. A forged or tampered event is a 400
        // and touches nothing.
        return res.status(400).json({
          error: 'Webhook signature verification failed',
          code: 'invalid_signature'
        });
      }

      try {
        res.json(await webhookService.process(event));
      } catch (error) {
        next(error);
      }
    }
  );

  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/generate', authenticate, async (req, res, next) => {
    try {
      const key = req.headers['idempotency-key'];

      if (!key || typeof key !== 'string' || key.trim() === '') {
        throw new ApiError(400, 'idempotency_key_required', 'Idempotency-Key header is required');
      }

      const parsed = GenerateBody.safeParse(req.body);

      if (!parsed.success) {
        throw new ApiError(400, 'invalid_request', 'Request body failed validation', {
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
        });
      }

      const result = await meter.record({
        tenant: req.tenant,
        key,
        body: parsed.data,
        ...(simulate ? { simulate } : {})
      });

      res.status(result.status).set('Idempotent-Replay', String(result.replayed)).json(result.body);
    } catch (error) {
      next(error);
    }
  });

  app.get('/usage', authenticate, async (req, res, next) => {
    try {
      res.json(await meter.usageFor(req.tenant));
    } catch (error) {
      next(error);
    }
  });

  app.get('/usage/events', authenticate, async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 25, 100);
      res.json({ events: await usageRepo.recentEvents(pool, req.tenant.id, limit) });
    } catch (error) {
      next(error);
    }
  });

  // The operator panel. Static, self-contained, and it talks to the same
  // authenticated endpoints a customer would - it has no privileged access.
  app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
  });

  app.post('/billing/checkout', authenticate, async (req, res, next) => {
    try {
      const base = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

      const session = await stripeService.createCheckoutSession({
        tenant: req.tenant,
        successUrl: `${base}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${base}/billing/cancelled`
      });

      res.json({ checkout_url: session.url, session_id: session.id });
    } catch (error) {
      next(error);
    }
  });

  // Landing pages Stripe redirects the browser back to after Checkout. Nothing is
  // granted here - the plan changes only when the signed webhook arrives.
  app.get('/billing/success', (req, res) => {
    res.json({
      status: 'checkout complete',
      note: 'Your plan updates when the signed webhook is verified, not from this redirect.'
    });
  });

  app.get('/billing/cancelled', (req, res) => {
    res.json({ status: 'checkout cancelled' });
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', code: 'not_found' });
  });

  // One place that turns an error into a status code. Anything that is not an
  // ApiError is a bug, so it becomes a 500 and the detail stays server-side.
  app.use((error, req, res, next) => {
    if (error instanceof ApiError) {
      return res.status(error.status).json(error.toBody());
    }

    console.error('unhandled error:', error);
    return res.status(500).json({ error: 'Internal server error', code: 'internal_error' });
  });

  return app;
}

module.exports = { buildApp };
