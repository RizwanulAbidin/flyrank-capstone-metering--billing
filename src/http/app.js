'use strict';

const express = require('express');
const { z } = require('zod');

const { ApiError } = require('../errors');
const { authenticate } = require('./auth');
const meter = require('../services/MeterService');

// Validation at the boundary: bad input becomes a clean 400, never a 500 from
// somewhere deep in the money math.
const GenerateBody = z.object({
  input_tokens: z.int().min(0).max(1_000_000),
  cached_input_tokens: z.int().min(0).max(1_000_000),
  max_output_tokens: z.int().min(0).max(100_000)
});

function buildApp({ simulate } = {}) {
  const app = express();
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
