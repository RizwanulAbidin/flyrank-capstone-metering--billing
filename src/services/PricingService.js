'use strict';

// Turns token counts into money, and turns a request into the conservative
// estimate the reservation is built from. Pure functions - no database, no clock.

const { costMicros, sumMicros } = require('../money');
const {
  PRICE_PER_MILLION_MICROS,
  TOKEN_CATEGORIES,
  RESERVE_REASONING_FACTOR
} = require('../config/pricing');

function readCategory(tokens, category) {
  const quantity = tokens[category] ?? 0;

  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new TypeError(`${category} must be a non-negative integer, received ${quantity}`);
  }

  return quantity;
}

// The token quota counts every category at face value. Pricing distinguishes
// them; the quota does not.
function totalTokens(tokens) {
  return TOKEN_CATEGORIES.reduce((sum, category) => sum + readCategory(tokens, category), 0);
}

// Each category is priced at its own rate and only then added together. This is
// the whole reason token costs are not "total tokens x one price".
function priceTokens(tokens) {
  const perCategory = {};

  for (const category of TOKEN_CATEGORIES) {
    perCategory[category] = costMicros(
      readCategory(tokens, category),
      PRICE_PER_MILLION_MICROS[category]
    );
  }

  return {
    per_category: perCategory,
    total_micros: sumMicros(Object.values(perCategory))
  };
}

function priceApiCalls(count) {
  return costMicros(count, PRICE_PER_MILLION_MICROS.api_call);
}

// What the request could cost at worst. Output is assumed to hit the requested
// maximum, and reasoning is assumed to match it. Reserving too little would let
// a tenant burst past the cap; reserving too much only refuses slightly early.
function estimate({ input_tokens, cached_input_tokens, max_output_tokens }) {
  const reasoningAllowance = Math.ceil(max_output_tokens * RESERVE_REASONING_FACTOR);

  const worstCase = {
    input: input_tokens,
    cached_input: cached_input_tokens,
    output: max_output_tokens,
    reasoning: reasoningAllowance
  };

  const tokenCost = priceTokens(worstCase);

  return {
    calls: 1,
    tokens: totalTokens(worstCase),
    cost_micros: sumMicros([tokenCost.total_micros, priceApiCalls(1)]),
    breakdown: worstCase
  };
}

// What the request actually cost, once the work has run.
function actual({ input_tokens, cached_input_tokens, output_tokens, reasoning_tokens }) {
  const used = {
    input: input_tokens,
    cached_input: cached_input_tokens,
    output: output_tokens,
    reasoning: reasoning_tokens
  };

  const tokenCost = priceTokens(used);

  return {
    calls: 1,
    tokens: totalTokens(used),
    token_cost_micros: tokenCost.total_micros,
    call_cost_micros: priceApiCalls(1),
    cost_micros: sumMicros([tokenCost.total_micros, priceApiCalls(1)]),
    breakdown: { tokens: used, per_category_micros: tokenCost.per_category }
  };
}

module.exports = { totalTokens, priceTokens, priceApiCalls, estimate, actual };
