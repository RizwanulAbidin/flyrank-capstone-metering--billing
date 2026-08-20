'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { now, setNow, billingPeriod } = require('../src/clock');

test('billingPeriod is the first day of the UTC month', () => {
  assert.equal(billingPeriod(new Date('2026-08-19T14:31:46.593Z')), '2026-08-01');
  assert.equal(billingPeriod(new Date('2026-01-31T23:59:59.999Z')), '2026-01-01');
  assert.equal(billingPeriod(new Date('2026-12-01T00:00:00.000Z')), '2026-12-01');
});

test('the month rolls over at UTC midnight, not local midnight', () => {
  const lastMoment = billingPeriod(new Date('2026-08-31T23:59:59.999Z'));
  const firstMoment = billingPeriod(new Date('2026-09-01T00:00:00.000Z'));

  assert.equal(lastMoment, '2026-08-01');
  assert.equal(firstMoment, '2026-09-01');
  assert.notEqual(lastMoment, firstMoment);
});

test('the clock can be pinned, and put back', () => {
  const restore = setNow('2026-02-14T09:00:00.000Z');

  assert.equal(now().toISOString(), '2026-02-14T09:00:00.000Z');
  assert.equal(billingPeriod(), '2026-02-01');

  restore();

  // Back to the real clock: within a second of Date.now().
  assert.ok(Math.abs(now().getTime() - Date.now()) < 1_000);
});

test('a leap-year February still reports the first of the month', () => {
  assert.equal(billingPeriod(new Date('2028-02-29T12:00:00.000Z')), '2028-02-01');
});
