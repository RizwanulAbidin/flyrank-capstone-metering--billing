# Usage Metering & Billing Engine

> **Status: complete.** Built, tested, and verified against live Stripe test mode.
> 109 tests passing. The design contract is in [`DESIGN.md`](DESIGN.md); the proof for each
> Definition-of-Done box is in [`EVIDENCE.md`](EVIDENCE.md).

The backend service that answers the three questions every SaaS product has to answer about a
customer: **how much have they used, what does it cost, and are they allowed to do this next
thing?**

FlyRank internship backend-track capstone.

## What it does

- **Meter** every billable action to a tenant, exactly once, even when the client retries.
- **Enforce** the tenant's plan quota *before* the action runs — and refuse honestly when it will not fit.
- **Show it**, on a live panel at `/dashboard`, so the limits and the refusals are visible rather than described.
- **Price** usage with real LLM token rules: cached input is cheaper, reasoning tokens bill as output.
- **Sync** subscription state from Stripe (test mode) through signature-verified, deduplicated webhooks.

Two plans (Free / Pro), two usage types (API calls, AI tokens), one billable endpoint. Small on
purpose: all of the difficulty is in getting a small thing exactly right.

## Beyond the brief

Two additions chosen deliberately, both about *enforcement* rather than reporting.

**Reserve → commit metering.** You cannot know how many tokens a request will use until after it
has run, yet the quota has to be checked before. So a request reserves a conservative estimate,
does the work, commits the actual amount, and releases the remainder. This also closes a hole a
plain check cannot: ten simultaneous requests each see room under the limit and all ten proceed.
A reservation is a row the next request can see.

**A hard spend cap, in money.** The same pre-flight check, denominated in micros rather than
counts, that *blocks* rather than warns. Dashboards and alerts are observability; this is
enforcement.

Plus one detail from the [IETF idempotency-key draft](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-02):
an idempotency key replayed with a **different** request body returns `422`, rather than silently
returning an unrelated earlier response.

## Architecture

Three paths. One writes usage, one reads it, one syncs payment state.

```
                    Authorization: Bearer <api key>
  client ──────────►│ Idempotency-Key: <unique>          POST /generate
                    ▼
         ┌──────────────────────────────────────────────────────────────┐
         │  1. INSERT idempotency key   UNIQUE(tenant, endpoint, key)   │
         │        duplicate?  ├─ different body ──────────────► 422     │
         │                    ├─ still running ───────────────► 409     │
         │                    └─ completed ──► replay stored response   │
         │                                                              │
         │  2. RESERVE  estimate high (worst-case output + reasoning)   │
         │        committed usage + held reservations vs 3 limits       │
         │              calls · tokens · spend cap                      │
         │        doesn't fit ─► drop key, 429 / 402 + which limit      │
         │        fits ───────► INSERT reservation (held, 5 min TTL)    │
         │                                                              │
         │  3. do the work            (simulated; actual ≠ estimate)    │
         │                                                              │
         │  4. COMMIT   INSERT usage_events with the ACTUAL amounts     │
         │              reservation ─► committed, surplus released      │
         └──────────────────────────────────────────────────────────────┘

  GET /usage ◄──── rollup(usage_events + held reservations)
                   { used, limits, cost_micros, held }

  Stripe Checkout (test mode) ──► subscription created
  Stripe ──signed webhook──► POST /webhooks/stripe
                               ├─ verify signature on the RAW body ─► forged = 400
                               ├─ INSERT stripe_event_id (pk)      ─► replay = ignored
                               └─ update tenant plan / status

  nightly job ──► release expired reservations · reconcile plans against Stripe
```

The two mechanisms that make this correct are both **database constraints, not code checks**: a
`UNIQUE` index stops duplicate keys, and a held reservation row is visible to the next request so
concurrent calls cannot all see the same headroom. See
[`DESIGN.md` §5](DESIGN.md) for why a read-then-check loses both races.

## Money

Every monetary value in this system is an **integer number of micros** (millionths of a dollar).
Never a float, never a decimal string.

Micros rather than cents because token prices are much smaller than a cent: at $3.00 per million
input tokens a single token costs 3 micros, which would round to zero cents and vanish.

Rounding happens in exactly one place — `costMicros` in [`src/money.js`](src/money.js) — and is
pinned by tests. See [`test/money.test.js`](test/money.test.js), including the one-line test that
documents why floats are not an option.

## Plans

| Plan | API calls / month | Tokens / month | Spend cap / month |
|---|---|---|---|
| Free | 1,000 | 100,000 | $1.00 |
| Pro | 50,000 | 5,000,000 | $100.00 |

Three limits, because a tenant can run out three different ways. The free spend cap is set low
relative to the token quota on purpose: 100,000 output tokens costs $1.50, so a request-heavy
workload hits the **money** cap first while a cached-input-heavy one hits the **token** count first.
Both orders are tested.

## Data model

Seven tables, every customer-owned row carrying `tenant_id`: `plans`, `tenants`, `subscriptions`,
`usage_events`, `idempotency_keys`, `reservations`, `processed_webhook_events`. Columns, indexes and
the reasoning are in [`DESIGN.md` §4](DESIGN.md).

## API

All five endpoints are built and covered by tests.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/generate` | API key + `Idempotency-Key` | The billable action |
| `GET` | `/usage` | API key | Rollup: used, limits, cost, held reservations |
| `GET` | `/usage/events` | API key | The tenant's recent usage events |
| `GET` | `/dashboard` | none | The metering panel (a client; it holds no privileges) |
| `POST` | `/billing/checkout` | API key | Create a Stripe Checkout session for Pro |
| `POST` | `/webhooks/stripe` | Stripe signature | Subscription sync |
| `GET` | `/health` | none | Liveness |

## Running it

You need Docker. Nothing else - no local Node, no local Postgres.

```
cp .env.example .env      # copy .env.example .env  on Windows
docker compose up --build
```

That one command builds the image, waits for Postgres to report healthy, applies migrations, seeds
two demo tenants, and serves on http://localhost:3000. It is safe to re-run: migrations are
recorded and skipped, and the seed only inserts tenants that do not already exist.

Check it is alive:

```
curl http://localhost:3000/health
```

### Demo credentials

Both tenants start on Free. Only the SHA-256 of each key is stored, and they are worthless outside
a local database.

| Tenant | API key |
|---|---|
| Acme Ltd | `sk_demo_acme_0000000000000000` |
| Globex Inc | `sk_demo_globex_000000000000000` |

### A billable request

```
curl -X POST http://localhost:3000/generate \
  -H "Authorization: Bearer sk_demo_acme_0000000000000000" \
  -H "Idempotency-Key: demo-001" \
  -H "Content-Type: application/json" \
  -d '{"input_tokens":1200,"cached_input_tokens":8000,"max_output_tokens":2000}'
```

On Windows PowerShell use `curl.exe --%` and escape the inner quotes, as in the A3 and A5
READMEs.

Send it twice with the same key and the second response is byte-identical, with one usage event
recorded. Send it again with a different body and the same key and you get `422`.

### The tests

The suite needs a database but not the API container:

```
docker compose up -d db
npm install
npm test
```

108 tests. The webhook tests generate their own Stripe signatures locally, so no Stripe account is
needed to run them.

### The panel

Open **http://localhost:3000/dashboard**.

Pick a tenant, then send traffic and watch the meters. The buttons cover the three cases worth
seeing: a normal request, a retry with the same idempotency key, and the same key with a changed
body. "Send until refused" walks a tenant into its limit.

The meters are **segmented rather than smooth**, because a quota is a count of discrete things and a
continuous bar would picture the wrong data type. Held reservations appear as dimmed segments, so an
in-flight request is visible instead of hidden.

The panel authenticates with a tenant's own API key and calls only `/usage`, `/usage/events` and
`/generate` - the same endpoints a customer gets. There is deliberately **no endpoint that lists all
tenants**: a convenient dashboard is not a good reason to undo tenant isolation. To show isolation,
open two tabs on different tenants.

### The background job

```
npm run reconcile                              # one pass, then exit
docker compose --profile jobs up -d reconcile  # scheduled, every RECONCILE_INTERVAL_MS
```

Releases reservations left held past their expiry, and corrects any tenant whose plan disagrees with
Stripe. Stripe is the authority on payment; this database only mirrors it.

- **Retries once** on a timeout, a 5xx or a rate limit. Never on a 404 or a 400 - those are answers,
  not glitches.
- **Alerts on failure** three ways: a marked `ALERT` log line, a non-zero exit code so a scheduler
  notices, and an optional POST to `ALERT_WEBHOOK_URL`.
- **Writes `output/reconcile-report.json`** every run - counts, corrections, and every failure with
  its reason.
- One tenant failing never abandons the rest of the run.

### Stripe (optional)

Only needed to run a real Checkout. Put a test-mode secret key and a price id in `.env`, then:

```
stripe login
stripe listen --forward-to localhost:3000/webhooks/stripe
```

Paste the printed `whsec_` into `.env` as `STRIPE_WEBHOOK_SECRET` and restart the stack. Pay with
card `4242 4242 4242 4242`, any future expiry, any CVC.

## Policies

Each of these has a test behind it. Full reasoning in [`DESIGN.md` §7](DESIGN.md).

**All-or-nothing boundary.** A request whose reservation does not fit is rejected in full — nothing
recorded, no partial usage. At 998 of 1,000 tokens, a request needing 5 is refused outright rather
than consuming the remaining 2.

**What counts toward the token quota.** Input + cached input + output + reasoning, counted raw.
Pricing treats those four categories differently; the quota does not.

**Status codes**, checked in order, first failure wins:

| Order | Condition | Code |
|---|---|---|
| 1 | subscription not active | `402` |
| 2 | spend cap would be exceeded | `402` |
| 3 | call or token quota would be exceeded | `429` |

The line between them: **`429` means a counted allowance is used up; `402` means money or plan
state is the problem.** Every rejection names the limit, the current value, and what was asked for.

**Idempotency.** Keys are scoped to `(tenant, endpoint)`. Same key and same body replays the
original response. Same key with a *different* body returns `422` — the client has a bug, and
silently replaying an unrelated response would hide it. Same key while the first is still in flight
returns `409`. Rejected requests do **not** persist their key, so a tenant who upgrades and retries
is re-evaluated rather than served a stale `429`.

**Reservation expiry.** A held reservation older than 5 minutes is released by the nightly job. A
process that dies between reserve and commit must not lock quota away forever.

**Billing periods are UTC calendar months**, read through an injectable clock so month rollover can
be tested rather than hoped for.

## Limitations

Decided in Phase 1, so these are choices rather than oversights. Reasoning in
[`DESIGN.md` §10](DESIGN.md).

**The headline non-goal: no invoicing, proration, or overage billing.** Usage is metered and priced;
turning that into a statement, charging past the limit, or fairly splitting a mid-cycle plan change
is out of scope.

Also not built:

- **Effective-dated pricing.** Prices are constants, so changing one would silently change
  historical totals. The fix is a price-version table with each usage event pinning the version that
  priced it.
- **Append-only ledger with reversals.** A failed downstream action would need its event deleted
  rather than compensated with a negative entry.
- **`GET /usage/explain`** — per-charge derivation for a support team.
- **Tenant-local billing timezones.** Everything is UTC.
- **API key rotation.** One hashed key per tenant.

The first three are a coherent "auditability" package that was weighed against the enforcement work
actually built (reserve → commit, hard spend cap) and deliberately deferred rather than
half-finished.

_Runtime limitations discovered during the build get added here in Phase 4._

## Repository files

| File | What it is |
|---|---|
| `DESIGN.md` | The design contract: data model, metering path, policies, non-goals |
| `DEMO.md` | The rehearsed six-minute demo script, with real captured output |
| `src/http/dashboard.html` | The metering panel - one self-contained file, no build step |
| `capstone.yaml` | Manifest the evaluator reads: run, seed, test, base URL, endpoints |
| `EVIDENCE.md` | One pasted proof per Definition-of-Done checkbox |
| `BUILDLOG.md` | Honest log of where AI helped and where it was wrong |
| `.env.example` | Every environment variable, with placeholder values |
