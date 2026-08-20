'use strict';

// Pricing constants, pinned. Quoted the way providers quote them: micros
// (millionths of a dollar) per 1,000,000 units.
//
// Two rules make this more than addition, and both are covered by tests:
//   - cached input is a tenth the price of fresh input
//   - reasoning tokens are billed at the OUTPUT rate, not free and not cheaper
//
// Changing a number here changes historical totals too, because prices are
// constants rather than effective-dated rows. That is a known limitation,
// recorded in the README.

const PRICE_PER_MILLION_MICROS = Object.freeze({
  input: 3_000_000, // $3.00 per 1M tokens
  cached_input: 300_000, // $0.30 per 1M tokens
  output: 15_000_000, // $15.00 per 1M tokens
  reasoning: 15_000_000, // billed as output
  api_call: 1_000_000_000 // $0.001 per call
});

// Every token category counts toward the token quota at face value. Pricing
// distinguishes them; the quota does not.
const TOKEN_CATEGORIES = Object.freeze(['input', 'cached_input', 'output', 'reasoning']);

// The reservation assumes reasoning could be as large as the output itself.
// Under-estimating lets a tenant burst past the cap; over-estimating only means
// being refused slightly early, with the surplus released seconds later.
const RESERVE_REASONING_FACTOR = 1;

module.exports = {
  PRICE_PER_MILLION_MICROS,
  TOKEN_CATEGORIES,
  RESERVE_REASONING_FACTOR
};
