'use strict';

// Every time the system asks "what time is it?" it asks here, so tests can pin
// the answer. Billing periods are UTC calendar months, and a month rollover you
// cannot pin is a month rollover you cannot test.

let currentNow = () => new Date();

function now() {
  return currentNow();
}

// Test helper. Returns a function that puts the real clock back.
function setNow(fixed) {
  const previous = currentNow;
  currentNow = typeof fixed === 'function' ? fixed : () => new Date(fixed);
  return () => {
    currentNow = previous;
  };
}

// The first day of the UTC month, as YYYY-MM-DD. This is the value stored on
// every usage event and reservation.
function billingPeriod(at = now()) {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

module.exports = { now, setNow, billingPeriod };
