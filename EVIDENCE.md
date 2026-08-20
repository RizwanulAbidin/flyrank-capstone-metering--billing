# Evidence

One pasted proof per Definition-of-Done checkbox. A claim without a transcript underneath it
counts as not done, so nothing here is marked complete before the output exists.

**Status key:** ☐ not started · ◐ in progress · ☑ done, proof below.

---

## Metering

### ☑ A billable action creates exactly one usage event, even under retries

```
$ npm test
ok - the same request retried records exactly one usage event
ok - different keys record different events
ok - key order in the body does not change the fingerprint
```

The second response mirrors the first byte for byte, and `SELECT COUNT(*) FROM usage_events`
for that tenant returns 1.

### ☑ A test proves double-counting cannot happen

```
ok - twenty simultaneous retries still record exactly one usage event
```

Twenty concurrent requests with one idempotency key. Every response is 200 or 409, every 200 is
byte-identical, exactly **one** usage event exists, and exactly one reservation is `committed`.
The guarantee is the `UNIQUE (tenant_id, endpoint, key)` constraint in `001_init.sql`, not an
application-level check.

### ☑ An idempotency key replayed with a different body is rejected with 422

```
$ curl -X POST localhost:3000/generate -H 'Idempotency-Key: demo-001'     -d '{"input_tokens":9,"cached_input_tokens":9,"max_output_tokens":9}'

HTTP 422
{"error":"This idempotency key was already used with a different request body",
 "code":"idempotency_key_reused"}
```

Beyond the brief; follows the IETF idempotency-key draft.

---

## Quotas

### ☑ Usage is checked against the tenant's plan; requests over the limit are rejected

```
ok - exactly at the token limit is allowed; one more is refused
ok - all-or-nothing: a request that does not fit does not eat the headroom either
ok - the API call quota blocks with 429
```

Ten 100-token requests land exactly on a 1,000-token limit and all succeed; the eleventh returns
429 and records nothing. A request needing 200 with only 100 left is refused **whole** - the
remaining 100 is still there afterwards for a request that fits.

### ☑ Responses carry the correct status codes (429 / 402) and say why

```
ok - an inactive subscription is refused with 402 before any counting
ok - the spend cap blocks with 402 even when the token quota has room
ok - when the spend cap and the token quota are both blown, the cap wins
ok - a rejection explains itself with numbers, not just a status code
```

```json
{"error":"Monthly token quota would be exceeded","code":"token_quota_exceeded",
 "details":{"limit":"token_limit","cap":1000,"committed":1000,"held":0,
            "requested":100,"would_reach":1100}}
```

### ☑ Reservations prevent concurrent requests from overshooting the limit

```
ok - twenty concurrent requests cannot overshoot a five-request limit
```

Twenty *distinct* requests fired simultaneously against a limit that fits five. Idempotency does
not help here - every request is legitimately different. Exactly 5 return 200, 15 return 429, and
recorded usage is exactly 500 of 500 tokens. Beyond the brief.

### ☑ A hard spend cap in money blocks the request

```
ok - the spend cap blocks with 402 even when the token quota has room
```

Cap of 2,600 micros, two requests at 1,300 each. The third is refused with 402 while the token
quota still has 999,800 tokens free - money ran out, not allowance. Beyond the brief.

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

### ☑ Database includes tenants, plans, subscriptions and usage events; data isolated per tenant

```
$ npm run migrate
migrations: applied 001_init.sql
```

Seven tables. Every customer-owned row carries `tenant_id`.

### ☐ Tests cover duplicate usage, quota boundaries, cost calculations, invalid and duplicate webhooks

_Phases 2–4._

### ☑ A tenant cannot read another tenant's data

```
ok - one tenant's usage never appears in another tenant's rollup
ok - an idempotency key is scoped to its tenant, not shared across the system
ok - one tenant's spending does not consume another tenant's quota
ok - a revoked or unknown key reaches nothing at all
```

The tests attempt the crossings rather than assuming they are impossible. The second is the
interesting one: two tenants sending the *same* idempotency key each get their own event, because a
shared key namespace would be a cross-tenant data leak disguised as a cache hit.

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
