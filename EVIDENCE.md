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

### ☑ Monthly usage rolls up into a cost figure per tenant

```
$ curl localhost:3000/usage -H 'Authorization: Bearer sk_demo_acme_0000000000000000'
{
  "plan": "pro",
  "billing_period": "2026-08-01",
  "limits":    {"api_calls":50000,"tokens":5000000,"spend_cap_micros":100000000},
  "used":      {"calls":1,"tokens":10471,"cost_micros":26065},
  "held":      {"calls":0,"tokens":0,"cost_micros":0},
  "remaining": {"calls":49999,"tokens":4989529,"spend_micros":99973935}
}
```

Held reservations are reported separately from committed usage, so an in-flight request is
visible rather than hidden.

### ☑ AI token pricing handles cached input, reasoning tokens, and output correctly

```
ok - cached input costs a tenth of fresh input for the same token count
ok - reasoning tokens are billed at exactly the output rate
ok - categories cannot be added together and multiplied by one rate
```

That third test computes the correct total (33,300 micros) and the naive
"sum the tokens, multiply by one rate" total (12,000 micros) and asserts they differ - it
documents the trap rather than merely avoiding it.

### ☑ Pricing constants are pinned and covered by tests

Constants live in `src/config/pricing.js`, quoted as micros per 1,000,000 units. Every rate is
covered by table-driven tests asserting exact integers - no tolerances.

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

### ☑ Subscription checkout works end to end in test mode

A real Checkout in the browser, test card `4242 4242 4242 4242`, Stripe sandbox
(`livemode: false`).

```
$ curl -X POST localhost:3000/billing/checkout -H 'Authorization: Bearer <acme key>'
{"checkout_url":"https://checkout.stripe.com/c/pay/cs_test_a1OBiy...","session_id":"cs_test_a1OBiy..."}

# after paying:
session status         : complete
payment_status         : paid
customer               : cus_V6pJReBK40tFZR
subscription           : sub_1U6beTIKVnVjolJIGcR6tsT7
```

The webhook then upgraded the tenant:

```
server responded: 200 {"received":true,"duplicate":false,"applied":"upgraded to pro"}

   name   | plan_code | subscription_status |   stripe_customer_id
 Acme Ltd | pro       | active              | cus_V6pJReBK40tFZR
```

`GET /usage` before: 1,000 calls / 100,000 tokens / $1.00 cap.
`GET /usage` after:  50,000 calls / 5,000,000 tokens / $100.00 cap - with recorded usage
(1 call, 10,471 tokens) unchanged. The plan moved; the ledger did not.

Live replay and forgery checks against the running server:

```
same event again        -> 200 {"received":true,"duplicate":true,"applied":null}
wrong signing secret    -> 400 {"error":"Webhook signature verification failed",
                                "code":"invalid_signature"}
```

### ☑ Webhooks verify signatures, ignore duplicate events, and update tenant plan/status

```
ok - a correctly signed checkout.session.completed upgrades the tenant to pro
ok - a forged signature is rejected with 400 and changes nothing
ok - a tampered payload with a real signature is rejected
ok - a missing signature header is rejected with 400
ok - the same event delivered twice is processed exactly once
ok - ten simultaneous deliveries of one event are processed exactly once
ok - subscription.deleted downgrades the tenant back to free
ok - a past_due subscription blocks billable requests
ok - an event type we do not handle is acknowledged, not retried forever
ok - an event for an unknown Stripe customer is ignored, not an error
```

A forged event leaves `plan_code` at `free` and writes no row to
`processed_webhook_events`. A verified one flips the tenant to `pro` and the new limits
(50,000 calls / 5,000,000 tokens) are live immediately. Replay protection is the
`stripe_event_id` primary key - ten simultaneous deliveries, exactly one applied.

The signatures are generated locally with `Stripe.webhooks.generateTestHeaderString`, so these
run offline on any machine that clones the repo.

---

## Data model, tests and documentation

### ☑ Database includes tenants, plans, subscriptions and usage events; data isolated per tenant

```
$ npm run migrate
migrations: applied 001_init.sql
```

Seven tables. Every customer-owned row carries `tenant_id`.

### ☑ Tests cover duplicate usage, quota boundaries, cost calculations, invalid and duplicate webhooks

```
$ npm test
# tests 108
# pass 108
# fail 0
```

Eight files: money, pricing, clock, quota (pure), metering, boundary, isolation, webhooks,
rollover, reconcile. The integration tests run against a real Postgres because the guarantees
being proved live in database constraints, not in application code.

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

### ☑ Month rollover is correct

```
ok - usage recorded in one month does not count against the next
ok - the boundary is one second wide, not one day
ok - events are filed under the period they happened in, not the period we ask in
ok - a held reservation only counts against its own month
```

A tenant filled to exactly its August limit is refused at 23:59:59 on 31 August and allowed at
00:00:00 on 1 September - one second apart, nothing else changed. Beyond the brief; possible
because `now()` comes from an injectable clock.

### ☑ Background job: reconciliation against Stripe

Satisfies shared requirement #3, which the core Definition of Done never mentions.

```
ok - a tenant Stripe says is paying, but we have as free, is corrected to pro
ok - a tenant whose subscription Stripe has cancelled is downgraded to free
ok - a tenant already in agreement with Stripe is left alone
ok - past_due at Stripe is mirrored, and then blocks billable requests
ok - one tenant failing does not abandon the rest of the run
ok - a reservation left held past its expiry is released
ok - a reservation still inside its window is left alone
ok - the report is honest about what it did
```

**And it was proved for real, not only in tests.** After the lost webhook (see `BUILDLOG.md`),
the demo tenant was left disagreeing with Stripe. Running the job against live Stripe:

```
$ npm run reconcile

Acme Ltd before : free / canceled
Acme Ltd after  : pro / active    (stripe_customer_id cus_V6pJReBK40tFZR)

second run      : drift_corrected 0     - idempotent, nothing left to fix
                  tenants_checked 37
                  errors 36             - leftover test tenants with fake customer ids
```

Those 36 failures are the resilience rule demonstrated live: 36 tenants errored, the run
completed anyway, and the one tenant that needed fixing was fixed.

### ☑ README + architecture diagram + setup instructions; submission-pack files present

All five required files present: `README.md`, `capstone.yaml`, `EVIDENCE.md`, `BUILDLOG.md`,
`.env.example` - plus `DESIGN.md` and an MIT `LICENSE`.

The README carries the ASCII architecture diagram, the plan table, the API surface, the written
policies, the limitations, and the run instructions. `capstone.yaml` lists every endpoint with its
expected status codes.

One documented command boots the whole system from nothing:

```
$ docker compose up --build

api-1  | migrations: applied 001_init.sql
api-1  | seed: 2 plans
api-1  | seed: tenant Acme Ltd [free/active] d0a77176-5bcb-4b04-80d6-45d8c4635c57
api-1  |         api key: sk_demo_acme_0000000000000000
api-1  | seed: tenant Globex Inc [free/active] 1d5cba41-d60c-4055-8075-bff319e984d5
api-1  | metering-billing listening on port 3000
```
