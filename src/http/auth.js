'use strict';

const crypto = require('node:crypto');

const { ApiError } = require('../errors');
const tenantRepo = require('../repositories/tenantRepo');

// Bearer <api key>. Only the SHA-256 is ever compared, and the plaintext is never
// logged - it is a credential, not a request id.
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;

    if (!header) {
      throw new ApiError(401, 'api_key_required', 'Authorization header is required');
    }

    const parts = header.split(' ');

    if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
      throw new ApiError(401, 'api_key_required', 'Expected: Authorization: Bearer <api key>');
    }

    const apiKeyHash = crypto.createHash('sha256').update(parts[1]).digest('hex');
    const tenant = await tenantRepo.findByApiKeyHash(apiKeyHash);

    if (!tenant) {
      throw new ApiError(401, 'api_key_invalid', 'Unknown API key');
    }

    req.tenant = tenant;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { authenticate };
