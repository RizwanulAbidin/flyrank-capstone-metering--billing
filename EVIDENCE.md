# Evidence

One pasted proof per Definition-of-Done checkbox. A claim without a transcript underneath it
counts as not done, so nothing here is marked complete before the output exists.

**Status key:** ☐ not started · ◐ in progress · ☑ done, proof below.

---

## Metering

### ☐ A billable action creates exactly one usage event, even under retries

_Phase 2._

### ☐ A test proves double-counting cannot happen

_Phase 2. Will include the parallel case — 20 simultaneous requests with one key — not only the
sequential retry._

### ☐ An idempotency key replayed with a different body is rejected with 422

_Phase 2. Beyond the brief; follows the IETF idempotency-key draft._

---

## Quotas

### ☐ Usage is checked against the tenant's plan; requests over the limit are rejected

_Phase 2._

### ☐ Responses carry the correct status codes (429 / 402) and say why

_Phase 2._

### ☐ Reservations prevent concurrent requests from overshooting the limit

_Phase 2. Beyond the brief._

### ☐ A hard spend cap in money blocks the request

_Phase 2. Beyond the brief._

---

## Cost calculation

### ☐ Monthly usage rolls up into a cost figure per tenant

_Phase 4._

### ☐ AI token pricing handles cached input, reasoning tokens, and output correctly

_Phase 4._

### ◐ Pricing constants are pinned and covered by tests

The money primitive every price calculation is built on is in place and pinned. The pricing
*config* itself lands in Phase 4; this is the arithmetic underneath it.

```
$ npm test

# tests 27
# suites 0
# pass 27
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 139.207
```

Includes the test that documents why money is stored as integers at all:

```js
test('floats cannot represent money, integers can', () => {
  assert.notEqual(0.1 + 0.2, 0.3);
  assert.equal(sumMicros([100_000, 200_000]), 300_000);
});
```

---

## Stripe integration

### ☐ Subscription checkout works end to end in test mode

_Phase 3._

### ☐ Webhooks verify signatures, ignore duplicate events, and update tenant plan/status

_Phase 3._

---

## Data model, tests and documentation

### ☐ Database includes tenants, plans, subscriptions and usage events; data isolated per tenant

_Phase 2._

### ☐ Tests cover duplicate usage, quota boundaries, cost calculations, invalid and duplicate webhooks

_Phases 2–4._

### ☐ A tenant cannot read another tenant's data

_Phase 2. Beyond the brief — the test actively attempts it._

### ☐ Month rollover is correct

_Phase 4. Beyond the brief — uses an injectable clock so the date can be pinned._

### ☐ Background job: reconciliation against Stripe

_Phase 4. Satisfies shared requirement #3, which the core checklist does not mention._

### ◐ README + architecture diagram + setup instructions; submission-pack files present

All five required files exist as of Phase 0: `README.md`, `capstone.yaml`, `EVIDENCE.md`,
`BUILDLOG.md`, `.env.example`.

The ASCII architecture diagram is in the README as of Phase 1, alongside the plan table, the API
surface, the policies and the limitations. The full design contract is in `DESIGN.md`.

Still outstanding: setup and run instructions, which cannot be written honestly until there is
something to run (Phase 2).
