'use strict';

const crypto = require('node:crypto');

// A stable hash of a request body, used to tell "the same request, retried" from
// "a different request reusing someone's idempotency key". Keys are sorted so
// that {a:1,b:2} and {b:2,a:1} fingerprint identically - the same request sent
// twice by a client that does not preserve key order must not look different.

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }

  return value;
}

function fingerprint(body) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex');
}

module.exports = { fingerprint, canonicalize };
