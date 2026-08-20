'use strict';

// Money in this system is always an integer number of MICROS - millionths of a
// US dollar. Never a float. Never a decimal string. See test/money.test.js for
// the one-line proof of why.
//
// Micros rather than cents because token prices are far smaller than a cent:
// at $3.00 per million input tokens, a single token costs 3 micros, which would
// round to zero cents and quietly disappear.
//
// Prices are quoted the way providers quote them: an amount per 1,000,000 units.
// "$3.00 per million tokens" is stored as 3_000_000 (micros) per million.

const MICROS_PER_DOLLAR = 1_000_000;
const UNITS_PER_PRICE_BLOCK = 1_000_000;

function assertSafeInteger(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer, received ${JSON.stringify(value)}`);
  }

  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} is outside the safe integer range: ${value}`);
  }
}

function assertNotNegative(value, name) {
  if (value < 0) {
    throw new RangeError(`${name} must not be negative, received ${value}`);
  }
}

// Cost of `quantity` units at `pricePerMillionMicros` per 1,000,000 units.
// Rounding happens here and nowhere else: half away from zero, per category.
// Pinning that rule in one place is what makes historical totals reproducible.
function costMicros(quantity, pricePerMillionMicros) {
  assertSafeInteger(quantity, 'quantity');
  assertNotNegative(quantity, 'quantity');
  assertSafeInteger(pricePerMillionMicros, 'pricePerMillionMicros');
  assertNotNegative(pricePerMillionMicros, 'pricePerMillionMicros');

  const product = quantity * pricePerMillionMicros;

  if (!Number.isSafeInteger(product)) {
    throw new RangeError(
      `cost overflow: ${quantity} x ${pricePerMillionMicros} exceeds the safe integer range`
    );
  }

  return Math.round(product / UNITS_PER_PRICE_BLOCK);
}

function sumMicros(values) {
  if (!Array.isArray(values)) {
    throw new TypeError(`values must be an array, received ${typeof values}`);
  }

  let total = 0;

  for (let i = 0; i < values.length; i += 1) {
    assertSafeInteger(values[i], `values[${i}]`);
    total += values[i];

    if (!Number.isSafeInteger(total)) {
      throw new RangeError('sum overflow: total exceeds the safe integer range');
    }
  }

  return total;
}

// Display only. Never feed the output of this back into a calculation.
// Built with integer arithmetic so no float ever touches a money value.
function formatMicros(micros) {
  assertSafeInteger(micros, 'micros');

  const sign = micros < 0 ? '-' : '';
  const absolute = Math.abs(micros);
  const dollars = Math.floor(absolute / MICROS_PER_DOLLAR);
  const fraction = String(absolute % MICROS_PER_DOLLAR).padStart(6, '0');

  return `${sign}$${dollars}.${fraction}`;
}

module.exports = {
  MICROS_PER_DOLLAR,
  UNITS_PER_PRICE_BLOCK,
  costMicros,
  sumMicros,
  formatMicros
};
