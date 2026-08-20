'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { totalTokens, priceTokens, priceApiCalls, estimate, actual } =
  require('../src/services/PricingService');

// --------------------------------------------------------------------------
// The three rules the brief calls out. If any of these break, the bill is wrong.
// --------------------------------------------------------------------------

test('cached input costs a tenth of fresh input for the same token count', () => {
  const fresh = priceTokens({ input: 100_000 }).total_micros;
  const cached = priceTokens({ cached_input: 100_000 }).total_micros;

  assert.equal(fresh, 300_000); // $0.30
  assert.equal(cached, 30_000); // $0.03
  assert.equal(fresh, cached * 10);
});

test('reasoning tokens are billed at exactly the output rate', () => {
  const asOutput = priceTokens({ output: 7_777 }).total_micros;
  const asReasoning = priceTokens({ reasoning: 7_777 }).total_micros;

  assert.equal(asReasoning, asOutput);
  assert.notEqual(asReasoning, 0); // not free, which is the tempting mistake
});

test('categories cannot be added together and multiplied by one rate', () => {
  const tokens = { input: 1_000, cached_input: 1_000, output: 1_000, reasoning: 1_000 };

  const correct = priceTokens(tokens).total_micros;
  const naive = priceTokens({ input: totalTokens(tokens) }).total_micros;

  assert.equal(correct, 3_000 + 300 + 15_000 + 15_000); // 33,300 micros
  assert.equal(naive, 12_000);
  assert.notEqual(correct, naive);
});

// --------------------------------------------------------------------------
// Pinned totals. Table-driven, exact integers, no tolerances.
// --------------------------------------------------------------------------

const PRICE_CASES = [
  { name: 'nothing costs nothing', tokens: {}, expected: 0 },
  { name: 'input only', tokens: { input: 1_200 }, expected: 3_600 },
  { name: 'cached only', tokens: { cached_input: 8_000 }, expected: 2_400 },
  { name: 'output only', tokens: { output: 2_500 }, expected: 37_500 },
  { name: 'reasoning only', tokens: { reasoning: 2_500 }, expected: 37_500 },
  {
    name: 'a realistic mixed request',
    tokens: { input: 1_200, cached_input: 8_000, output: 2_500, reasoning: 400 },
    expected: 3_600 + 2_400 + 37_500 + 6_000
  },
  {
    name: 'a cache-heavy request is dominated by its output',
    tokens: { input: 100, cached_input: 50_000, output: 900, reasoning: 0 },
    expected: 300 + 15_000 + 13_500 + 0
  }
];

for (const testCase of PRICE_CASES) {
  test(`priceTokens: ${testCase.name}`, () => {
    assert.equal(priceTokens(testCase.tokens).total_micros, testCase.expected);
  });
}

test('priceTokens reports every category separately', () => {
  const result = priceTokens({ input: 1_000, cached_input: 1_000, output: 1_000, reasoning: 1_000 });

  assert.deepEqual(result.per_category, {
    input: 3_000,
    cached_input: 300,
    output: 15_000,
    reasoning: 15_000
  });
});

test('an API call costs a tenth of a cent', () => {
  assert.equal(priceApiCalls(1), 1_000);
  assert.equal(priceApiCalls(1_000), 1_000_000); // $1.00 for a thousand calls
});

// --------------------------------------------------------------------------
// The quota counts every category at face value; pricing does not.
// --------------------------------------------------------------------------

test('totalTokens counts all four categories raw', () => {
  assert.equal(totalTokens({ input: 10, cached_input: 20, output: 30, reasoning: 40 }), 100);
});

test('totalTokens treats a missing category as zero', () => {
  assert.equal(totalTokens({ input: 10 }), 10);
});

test('totalTokens rejects a fractional count', () => {
  assert.throws(() => totalTokens({ input: 1.5 }), TypeError);
});

test('priceTokens rejects a negative count', () => {
  assert.throws(() => priceTokens({ output: -1 }), TypeError);
});

// --------------------------------------------------------------------------
// The estimate must never be smaller than what actually happens. Under-reserving
// is the dangerous direction: it lets a tenant burst past the cap.
// --------------------------------------------------------------------------

test('the estimate reserves an equal allowance for reasoning tokens', () => {
  const result = estimate({ input_tokens: 100, cached_input_tokens: 0, max_output_tokens: 500 });

  // 100 input + 0 cached + 500 output + 500 reasoning allowance
  assert.equal(result.tokens, 1_100);
  assert.equal(result.breakdown.reasoning, 500);
});

test('the estimate includes the API call itself', () => {
  const result = estimate({ input_tokens: 0, cached_input_tokens: 0, max_output_tokens: 0 });

  assert.equal(result.calls, 1);
  assert.equal(result.cost_micros, 1_000); // just the call
});

const REQUEST = { input_tokens: 1_200, cached_input_tokens: 8_000, max_output_tokens: 2_000 };

const ACTUAL_OUTCOMES = [
  { name: 'output and reasoning both at maximum', output_tokens: 2_000, reasoning_tokens: 2_000 },
  { name: 'typical - well under the maximum', output_tokens: 900, reasoning_tokens: 150 },
  { name: 'no output at all', output_tokens: 0, reasoning_tokens: 0 },
  { name: 'output at max, no reasoning', output_tokens: 2_000, reasoning_tokens: 0 }
];

for (const outcome of ACTUAL_OUTCOMES) {
  test(`the estimate covers the actual: ${outcome.name}`, () => {
    const reserved = estimate(REQUEST);
    const used = actual({
      input_tokens: REQUEST.input_tokens,
      cached_input_tokens: REQUEST.cached_input_tokens,
      output_tokens: outcome.output_tokens,
      reasoning_tokens: outcome.reasoning_tokens
    });

    assert.ok(
      reserved.tokens >= used.tokens,
      `reserved ${reserved.tokens} tokens but used ${used.tokens}`
    );
    assert.ok(
      reserved.cost_micros >= used.cost_micros,
      `reserved ${reserved.cost_micros} micros but used ${used.cost_micros}`
    );
  });
}

test('a typical request releases most of what it reserved', () => {
  const reserved = estimate(REQUEST);
  const used = actual({
    input_tokens: 1_200,
    cached_input_tokens: 8_000,
    output_tokens: 900,
    reasoning_tokens: 150
  });

  // If these were ever equal, the release path would never run and
  // reserve-then-commit would be untested theatre.
  assert.notEqual(reserved.tokens, used.tokens);
  assert.equal(reserved.tokens - used.tokens, 2_950);
});
