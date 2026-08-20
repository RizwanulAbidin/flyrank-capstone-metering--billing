# Design

Phase 1 output. The contract the rest of the build is written against.

---

## 1. The problem

A tenant makes a billable request. Before it runs, the service has to answer three questions:

1. Has this exact request already been recorded? (retries must not double-charge)
2. Will it fit inside the tenant's remaining allowance?
3. What does it cost?

All three are hard because the answers change under concurrency, under retries, and — for AI
tokens — because **the quantity is not known until after the work has run**.

## 2. Plans

Two plans. Three limits each, because a tenant can run out in three different ways.

| Plan | API calls / month | Tokens / month | Spend cap / month |
|---|---|---|---|
| `free` | 1,000 | 100,000 | $1.00 (`1_000_000` micros) |
| `pro` | 50,000 | 5,000,000 | $100.00 (`100_000_000` micros) |

The free spend cap is set deliberately low relative to the token quota. At the output rate, 100,000
tokens costs $1.50 — so **on the free plan the money cap binds before the token count does**, while
a workload made mostly of cached input hits the token count first. Which limit stops you depends on
what you send, and both paths are tested.

## 3. Pricing

Constants live in `src/config/pricing.js`, quoted the way providers quote them: micros per
1,000,000 units.

| Category | Rate | Micros per million |
|---|---|---|
| `input` | $3.00 / M tokens | `3_000_000` |
| `cached_input` | $0.30 / M tokens | `300_000` |
| `output` | $15.00 / M tokens | `15_000_000` |
| `reasoning` | billed as output | `15_000_000` |
| `api_call` | $0.001 per call | `1_000_000_000` |

Two rules that make this more than addition, and which the pinned tests enforce:

- **Cached input is a tenth of fresh input.** The categories cannot be summed and multiplied by one
  rate.
- **Reasoning tokens are billed at the output rate**, not free and not a separate cheaper class.

All arithmetic goes through `costMicros` in `src/money.js`, which is the only place rounding
happens.

## 4. Data model

Seven tables. Every row that belongs to a customer carries `tenant_id`.

```
plans                      code (pk) | api_call_limit | token_limit
                           spend_cap_micros | stripe_price_id

tenants                    id (pk) | name | plan_code -> plans.code
                           subscription_status | stripe_customer_id (unique)
                           api_key_hash (unique) | created_at

subscriptions              id (pk) | tenant_id -> tenants
                           stripe_subscription_id (unique) | status
                           current_period_start | current_period_end | updated_at

idempotency_keys           id (pk) | tenant_id -> tenants | endpoint | key
                           request_fingerprint | state | response_status | response_body
                           created_at
                           UNIQUE (tenant_id, endpoint, key)      <-- the real enforcement

reservations               id (pk) | tenant_id -> tenants | idempotency_key_id
                           usage_type | estimated_qty | estimated_cost_micros
                           state | billing_period | created_at | expires_at

usage_events               id (pk) | tenant_id -> tenants | usage_type
                           quantity | cost_micros | breakdown (jsonb)
                           reservation_id | idempotency_key_id
                           occurred_at | billing_period

processed_webhook_events   stripe_event_id (pk) | event_type | processed_at
```

**Indexes that earn their place**

- `usage_events (tenant_id, billing_period)` — every rollup and every quota check reads exactly this.
- `reservations (tenant_id, billing_period, state)` — the held-reservation total, read on every request.
- `UNIQUE (tenant_id, endpoint, key)` on `idempotency_keys` — not an optimisation, this *is* the
  duplicate-prevention mechanism.
- `processed_webhook_events (stripe_event_id)` as the primary key — same trick for webhook replays.

**`billing_period` is stored, not computed.** A `date` holding the first day of the UTC month. It
makes the monthly rollup an index lookup rather than date arithmetic across a whole table, and it
means an event's period can never drift if the clock logic later changes.

**Money columns are `bigint`.** Micros overflow a 32-bit integer at about $2,147.

## 5. Concurrency: why a check is not enough

The naive implementation reads the current usage, compares it to the limit, and inserts. Two things
break it, and each has its own mechanism here.

**Duplicates.** Two retries of the same request arrive together. Both read the idempotency table,
both find nothing, both insert. The fix is not a better read — it is `UNIQUE (tenant_id, endpoint,
key)`. Insert first, and let the database reject the second. The application catches that specific
error and treats it as "someone else got here first".

**Overshoot.** Ten *different* requests arrive together, each worth 500 tokens, against 1,000
remaining. All ten read "1,000 remaining", all ten proceed, and the tenant ends 4,000 over. The fix
is that a reservation is a **row**: request two counts request one's held reservation, because it is
already committed to the table.

## 6. The metering path

```
POST /generate
  Authorization: Bearer <tenant api key>
  Idempotency-Key: <client-generated unique string>
  { "input_tokens": 1200, "cached_input_tokens": 8000, "max_output_tokens": 2000 }
```

```
 1  authenticate            -> tenant, or 401
 2  validate body (Zod)     -> or 400
 3  fingerprint = sha256(canonical json of body)
 4  INSERT idempotency_keys (state = in_progress)
      |
      +-- unique violation -> read the existing row
             fingerprint differs   -> 422  same key, different request
             state = in_progress   -> 409  a retry arrived while the first is still running
             state = completed     -> replay the stored response verbatim
 5  estimate  (deliberately high - see 6.1)
 6  RESERVE   (one transaction)
      recompute committed usage + held reservations for this period
      does it fit under all three limits?
         no  -> delete the idempotency row, return 429 / 402  (see 6.3)
         yes -> INSERT reservations (state = held, expires_at = now + 5 min)
 7  do the work             (simulated - see 6.2)
 8  COMMIT    (one transaction)
      INSERT usage_events for the api_call and for the actual tokens
      reservations.state = committed
 9  store the 200 response on the idempotency row, return it
```

### 6.1 The estimate is deliberately too big

Tokens cannot be counted before the work runs, so the reservation covers the worst case:

```
reserved_tokens = input_tokens
                + cached_input_tokens
                + max_output_tokens
                + (max_output_tokens * RESERVE_REASONING_FACTOR)
```

with `RESERVE_REASONING_FACTOR = 1.0` — that is, assume reasoning could be as large as the output
itself. Under-estimating is the dangerous direction: it lets a tenant burst past the cap. Over-
estimating only means the tenant is briefly told "no" slightly early, and the surplus is released
seconds later.

### 6.2 The work is simulated, but the divergence is real

There is no model call. The endpoint generates `output_tokens` and `reasoning_tokens` below the
requested maximum. **The actual must differ from the estimate**, or reserve-then-commit is theatre
that never exercises the release path. The generator is injectable so tests can pin it.

### 6.3 A rejected request does not poison its idempotency key

When the quota check fails, the in-progress idempotency row is **deleted** rather than completed
with the 429.

The alternative — storing the rejection — means a tenant who upgrades to Pro and retries with the
same key gets served a stale 429 from before the upgrade. Only successful outcomes are persisted for
replay. A retry of a rejected request is simply re-evaluated, and since nothing was recorded, that
is safe.

## 7. Policies

Each of these is a sentence with a test behind it.

**All-or-nothing boundary.** A request whose reservation does not fit is rejected in full. Nothing
is recorded, no partial usage, no partial charge. At 998 of 1,000 tokens a request needing 5 is
refused outright — it does not consume the remaining 2.

**What counts toward the token quota.** Input + cached input + output + reasoning, counted raw.
Pricing treats the four categories differently; the *quota* does not distinguish them.

**Status codes.** Checked in this order, first failure wins:

| Order | Condition | Code | Meaning |
|---|---|---|---|
| 1 | subscription not active | `402` | plan or payment problem |
| 2 | spend cap would be exceeded | `402` | money limit — upgrading fixes it |
| 3 | call or token quota would be exceeded | `429` | counted allowance used up |

The dividing line: **`429` means a counted allowance is used up; `402` means money or plan state is
the problem.** Every rejection body names the limit, the current value, and what was requested.

**Idempotency.** Keys are scoped to `(tenant, endpoint)`. Same key + same body → the original
response. Same key + different body → `422`, per the IETF idempotency-key draft, because the client
has a bug and silently replaying an unrelated response would hide it. Same key while the first is
still running → `409`.

**Reservation expiry.** A held reservation older than 5 minutes is released by the reconciliation
job. A process that crashes between reserve and commit must not lock quota away permanently.

**Billing periods are UTC calendar months.** `now()` comes from an injectable clock so the rollover
can be tested rather than hoped for.

## 8. Layers

```
src/
  http/           routes, auth middleware, request validation, error -> status mapping
  services/       MeterService, QuotaService, PricingService, StripeService
  repositories/   tenants, usage, idempotency, reservations, webhooks  (all SQL lives here)
  db/             pool.js, migrations/
  config/         plans.js, pricing.js
  money.js        integer money primitive
  clock.js        injectable now()
```

The rule: **services never contain SQL, repositories never contain business rules.** Swapping
Postgres for something else should touch `repositories/` and `db/` only.

## 9. API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/generate` | API key + `Idempotency-Key` | The billable action |
| `GET` | `/usage` | API key | Rollup: used, limits, cost, held reservations |
| `POST` | `/billing/checkout` | API key | Create a Stripe Checkout session for Pro |
| `POST` | `/webhooks/stripe` | Stripe signature | Subscription sync |
| `GET` | `/health` | none | Liveness |

## 10. Non-goals

**The headline one: no invoicing, proration, or overage billing.** Usage is metered and priced;
turning that into a monthly statement, charging for usage past the limit, or fairly splitting a
mid-cycle plan change is out of scope.

Also deliberately not built, and recorded so it reads as a decision rather than an omission:

- **Effective-dated pricing.** Prices are constants, so changing one would change historical
  totals. The fix is a price-version table with each event pinning the version that priced it.
- **Append-only ledger with reversals.** A failed downstream action would currently need its event
  deleted rather than compensated with a negative entry.
- **`GET /usage/explain`** — per-charge derivation for support.
- **Tenant-local billing timezones.** Everything is UTC.
- **API key rotation.** One hashed key per tenant.
