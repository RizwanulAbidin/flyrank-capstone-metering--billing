'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MICROS_PER_DOLLAR,
  costMicros,
  sumMicros,
  formatMicros
} = require('../src/money');

// --------------------------------------------------------------------------
// Shape 1: a plain assertion.
// --------------------------------------------------------------------------

test('a dollar is one million micros', () => {
  assert.equal(MICROS_PER_DOLLAR, 1_000_000);
});

// This test exists as documentation. It is the entire reason money is stored
// as integers here, and it is the answer to "why not just use a number?".
test('floats cannot represent money, integers can', () => {
  assert.notEqual(0.1 + 0.2, 0.3);
  assert.equal(sumMicros([100_000, 200_000]), 300_000);
});

// --------------------------------------------------------------------------
// Shape 2: a table-driven test. One row per case, one assertion, many cases.
// Prices below mirror how providers actually quote LLM tokens.
// --------------------------------------------------------------------------

const INPUT_PER_MILLION = 3_000_000; // $3.00 per 1M tokens
const CACHED_INPUT_PER_MILLION = 300_000; // $0.30 per 1M tokens - ten times cheaper
const OUTPUT_PER_MILLION = 15_000_000; // $15.00 per 1M tokens

const COST_CASES = [
  { name: 'zero tokens cost nothing', quantity: 0, price: INPUT_PER_MILLION, expected: 0 },
  { name: 'one input token', quantity: 1, price: INPUT_PER_MILLION, expected: 3 },
  { name: 'exactly one million input tokens is $3.00', quantity: 1_000_000, price: INPUT_PER_MILLION, expected: 3_000_000 },
  { name: '2500 output tokens', quantity: 2_500, price: OUTPUT_PER_MILLION, expected: 37_500 },
  { name: '10k cached input tokens', quantity: 10_000, price: CACHED_INPUT_PER_MILLION, expected: 3_000 },
  { name: 'cached input is a tenth of fresh input', quantity: 10_000, price: INPUT_PER_MILLION, expected: 30_000 },
  { name: 'a free price yields no cost', quantity: 999_999, price: 0, expected: 0 },
  { name: 'rounds a half micro away from zero', quantity: 1, price: 2_500_000, expected: 3 },
  { name: 'rounds another half micro away from zero', quantity: 1, price: 1_500_000, expected: 2 },
  { name: 'rounds down below a half micro', quantity: 1, price: 1_400_000, expected: 1 }
];

for (const testCase of COST_CASES) {
  test(`costMicros: ${testCase.name}`, () => {
    assert.equal(costMicros(testCase.quantity, testCase.price), testCase.expected);
  });
}

// --------------------------------------------------------------------------
// Shape 3: proving the bad input is refused, not silently accepted.
// --------------------------------------------------------------------------

test('costMicros rejects a fractional quantity', () => {
  assert.throws(() => costMicros(1.5, INPUT_PER_MILLION), TypeError);
});

test('costMicros rejects a negative quantity', () => {
  assert.throws(() => costMicros(-1, INPUT_PER_MILLION), RangeError);
});

test('costMicros rejects a negative price', () => {
  assert.throws(() => costMicros(1, -1), RangeError);
});

test('costMicros rejects a quantity that is not a number', () => {
  assert.throws(() => costMicros('1000', INPUT_PER_MILLION), TypeError);
});

test('costMicros refuses to overflow rather than returning a wrong total', () => {
  assert.throws(() => costMicros(Number.MAX_SAFE_INTEGER, OUTPUT_PER_MILLION), RangeError);
});

// --------------------------------------------------------------------------
// sumMicros
// --------------------------------------------------------------------------

test('sumMicros of nothing is zero', () => {
  assert.equal(sumMicros([]), 0);
});

test('sumMicros adds the token categories of one request', () => {
  const input = costMicros(1_200, INPUT_PER_MILLION);
  const cached = costMicros(8_000, CACHED_INPUT_PER_MILLION);
  const output = costMicros(2_500, OUTPUT_PER_MILLION);

  assert.equal(sumMicros([input, cached, output]), 3_600 + 2_400 + 37_500);
});

test('sumMicros rejects a float hiding in the list', () => {
  assert.throws(() => sumMicros([1, 2.5, 3]), TypeError);
});

// --------------------------------------------------------------------------
// formatMicros - display only
// --------------------------------------------------------------------------

const FORMAT_CASES = [
  { micros: 0, expected: '$0.000000' },
  { micros: 3, expected: '$0.000003' },
  { micros: 37_500, expected: '$0.037500' },
  { micros: 1_000_000, expected: '$1.000000' },
  { micros: 1_234_567, expected: '$1.234567' },
  { micros: 47_320_000, expected: '$47.320000' },
  { micros: -500, expected: '-$0.000500' }
];

for (const testCase of FORMAT_CASES) {
  test(`formatMicros: ${testCase.micros} renders as ${testCase.expected}`, () => {
    assert.equal(formatMicros(testCase.micros), testCase.expected);
  });
}
