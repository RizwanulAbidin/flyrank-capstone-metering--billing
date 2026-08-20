'use strict';

// Stands in for the model call. No AI key, no network - the point of the capstone
// is metering numbers, not producing text.
//
// What matters is that the ACTUAL result differs from the reserved estimate. If
// they were always equal, the release path would never run and reserve-then-commit
// would be theatre that passes its own tests. Output lands between 30% and 80% of
// the requested maximum, with reasoning somewhere under half of that.
//
// Injectable, so tests can pin the outcome instead of hoping.

function simulateWork({ max_output_tokens }) {
  const output = Math.floor(max_output_tokens * (0.3 + Math.random() * 0.5));
  const reasoning = Math.floor(output * Math.random() * 0.4);

  return { output_tokens: output, reasoning_tokens: reasoning };
}

// Test helper: always returns exactly what you tell it to.
function fixedSimulator(output_tokens, reasoning_tokens) {
  return () => ({ output_tokens, reasoning_tokens });
}

module.exports = { simulateWork, fixedSimulator };
