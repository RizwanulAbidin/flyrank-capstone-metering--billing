# Build log

Where AI helped, where it was wrong, and what I changed. Kept as I go, not reconstructed at the
end. Honesty is the point — a clean-looking log would be worth less than an accurate one.

Tooling used: Claude Code (Opus), as an explain-then-I-write pair rather than a code generator,
except where noted below.

---

## Phase 0 — repo and test foundation (2026-08-20)

### What I decided

- **Chose this capstone** over the other options: the most bounded scope, and the difficulty is
  correctness rather than infrastructure.
- **Chose the "enforcement" additions** (reserve → commit metering, hard spend cap) over the
  "auditability" ones (effective-dated pricing, append-only ledger, `/usage/explain`). Both were
  put to me with costs attached; I picked the one that is the better engineering story and pushed
  the other into the README as future work rather than half-building both.
- **Added the `422` idempotency-fingerprint check** because it is roughly an hour of work and is
  specified behaviour rather than something invented.

### Where AI helped

- **Gap analysis.** It read the brief against my five completed assignments and found that four
  of the five "you already have the parts" rows point at assignments I have not done (A5, A6,
  A12, A14), and that I have never written a single automated test — every repo I own has the
  default `no test specified` script and there is no test file anywhere. I had not noticed either.
- **Found a requirement I would have missed.** Shared requirement #3 in §12 demands at least one
  background job, but the §6 Definition-of-Done checklist never mentions one. Easy to build the
  whole thing and fail on it. The reconciliation job is now planned in from the start rather than
  bolted on.
- **Research on the extras.** Three findings that changed the plan: that the industry gap is
  enforcement rather than observability (teams with dashboards, alerts and provider caps still get
  runaway bills); that token counts are unknown before a call, which the brief's "check quota
  before the action" quietly assumes away; and that there is an IETF draft specifying the `422`
  behaviour, so I am implementing to a spec rather than to taste.
- **Wrote the Phase 0 scaffolding** — the five pack files, `package.json`, `src/money.js` and
  `test/money.test.js`. I reviewed all of it; the parts I want to be able to defend are noted
  below.

### Where the plan was wrong, and what changed

- **The original plan had me learning the test runner on my A9 scraper code**, on the grounds that
  I already know the right answers there. Building it, we dropped that: the brief forbids mixing
  capstone code with track assignments, and copying scraper functions into this repo to practise
  on would have done exactly that. Replaced with `src/money.js` — real capstone code, pure
  functions, obvious right answers, and needed by everything later anyway. Better outcome from a
  rule I nearly broke.
- **Repo name.** The brief suggests `flyrank-capstone-metering-billing`; I created
  `flyrank-capstone-metering--billing` with a double hyphen. Noted rather than silently ignored —
  decision on renaming recorded below once made.

### Things I need to be able to explain

Flagging these now so I actually understand them rather than discovering at the demo that I don't:

- Why money is micros and not cents. (Answer: at $3.00 per million tokens one token costs 3
  micros; in cents that rounds to zero and the charge disappears.)
- Why `costMicros` refuses to overflow instead of returning a wrong number. A silently wrong total
  in a billing system is worse than a crash.
- Why rounding happens in exactly one function. If several places round, the same inputs can
  produce different totals depending on the path taken through the code.

### Gate

`npm test` — 27 tests, all passing. Wired into `capstone.yaml` as the `test:` command.

---

## Phase 1 — design (2026-08-20)

Output: [`DESIGN.md`](DESIGN.md), plus the architecture, plans, policies, API and limitations
sections of the README.

### Decisions worth defending

- **Three limits per plan, not two.** The brief lists calls and tokens; the spend cap I added makes
  a third. Free's cap ($1.00) is deliberately low against its token quota (100k tokens costs $1.50
  at the output rate) so that the money limit and the count limit bind in different orders
  depending on the token mix. Both orders get a test.
- **`billing_period` is stored on each row, not derived at query time.** Makes the rollup an index
  lookup, and means an event's period cannot drift if the clock logic changes later.
- **A rejected request deletes its idempotency key rather than storing the 429.** Storing it means
  a tenant who upgrades and retries with the same key is served a stale rejection from before the
  upgrade. Only successful outcomes are persisted for replay. Nothing was recorded on a rejection,
  so re-evaluating is safe.
- **Status-code precedence written down**: inactive subscription → `402`, spend cap → `402`, counted
  quota → `429`. The line is that `429` means an allowance is used up and `402` means money or plan
  state is the problem. Without a stated order, "which code when both are exceeded?" gets answered
  differently in different code paths.
- **The reservation over-estimates on purpose** — worst-case output plus an equal allowance for
  reasoning tokens. Under-estimating lets a tenant burst past the cap; over-estimating only means
  being told "no" slightly early, with the surplus released seconds later.
- **The simulated work must return an amount different from the estimate.** If actual always equals
  estimate, the release path never runs and reserve-then-commit is untested theatre.

### Where AI helped

Wrote `DESIGN.md` and the README sections from the plan we agreed, and pushed back on two things I
had not thought about: that the estimate needs a reasoning allowance at all (I would have reserved
only `max_output_tokens`), and that a rejected request storing its idempotency key creates the
stale-429 trap above.

### Still open

Nothing blocking. The plan limits and the 5-minute reservation TTL are arbitrary-but-reasonable
numbers; if they turn out to make a poor demo they get changed in Phase 5 and noted here.

### Gate

Design doc written. Data model, metering path, policies, status codes and non-goals all settled
before any service code exists.

---

## Phase 2 — core billing logic (2026-08-20)

Migrations, tenant auth, the idempotency layer, reserve → commit, quota enforcement, and
`POST /generate` + `GET /usage`. 86 tests, all passing.

### Two real bugs the tests found

**1. The test suite was deleting its own data.** Every integration test started with a `TRUNCATE`.
Alone, each file passed. Together, 15 of 86 failed — a request would suddenly return `401`
mid-test because a *different* test file, running in a parallel process, had just truncated the
tenants table.

The lazy fix is `--test-concurrency=1`. I did not do that, because it hides the problem rather than
solving it and makes the suite slower forever. Instead every test now creates its own tenant with a
random API key and asserts only on that tenant's rows. Since every table is tenant-scoped, the tests
isolate exactly the way real customers do. No reset needed, and they stay parallel.

**2. Money was arriving from the database as a string.** A test asserting the spend cap failed with
`'2600' !== 2600`. node-postgres returns `bigint` columns as strings rather than risk losing
precision above 2^53 — and every money column here is `bigint`.

What makes this worth writing down is that it *almost worked*. `4000 > '2600'` coerces the string
and gives the right answer, so every quota comparison behaved correctly. The bug was invisible until
a value was compared with `===`, or added to something, or serialised into a response as `"2600"`.

Fixed by converting once at the repository boundary in `mapTenant`, since that is the only layer
that knows the value came out of Postgres. The regression test now asserts `typeof === 'number'`,
not just the value.

I would not have caught either of these by reading the code.

### Decisions worth defending

- **Reservations are serialised with a row lock on the tenant** (`SELECT ... FOR UPDATE OF t`), not
  with `SERIALIZABLE` isolation. Two requests from the same tenant queue; different tenants are
  unaffected. It is one line, it is easy to explain, and the twenty-concurrent-request test proves
  it works.
- **The idempotency claim commits immediately, in its own short transaction**, before the slow work
  starts. Holding it open would make a duplicate block on the row lock for the whole request instead
  of being told the truth straight away.
- **The work happens outside any transaction.** It is the slow part; holding a database lock across
  it would serialise the entire tenant for the duration.
- **One reservation row per request** carrying all three estimates, rather than one row per usage
  type. This refines the Phase 1 design — the release path is a single state transition instead of
  two rows to keep in sync.
- **The concurrency test does not assert "1 success and 19 conflicts".** That split depends on
  timing: a duplicate arriving mid-flight gets `409`, one arriving after completion gets a replayed
  `200`, and both are correct. Pinning the ratio would make the suite flaky under load — the worst
  possible property for the test guarding against double-charging. It asserts the invariant instead:
  every response is `200` or `409`, all successes are identical, and exactly one usage event exists.

### Where AI helped

Wrote the repositories, services, HTTP layer and tests. It also diagnosed both bugs above from the
failure output rather than me having to bisect them.

### Where I need to be able to explain myself

- Why the `UNIQUE (tenant_id, endpoint, key)` constraint is the duplicate prevention, and a
  read-then-insert is not.
- Why a held reservation has to be a row rather than a number held in memory.
- Why `409` and not `429` when a duplicate arrives mid-flight.

### Gate

`npm test` — 86 passing, 0 failing, stable across three consecutive runs. The double-count test
passes under twenty simultaneous requests, and the boundary returns `429`/`402` per the documented
precedence.

---

## Phase 3 - Stripe integration (2026-08-20)

Checkout session creation, the webhook handler with signature verification and replay protection,
and subscription/plan sync. 96 tests passing.

### The bug that cost the most time: a connection-pool deadlock

The test firing ten simultaneous deliveries of one webhook event hung forever. No error, no
timeout - the whole suite just stopped.

The cause is worth remembering. `WebhookService` opened a transaction, which borrows one connection
from the pool. Inside it, `tenantRepo.findById` called `pool.query` - asking the pool for a
**second** connection. node-postgres defaults to a maximum of ten. Ten concurrent webhooks meant ten
transactions each holding one connection, all of them then waiting for an eleventh that could only
become free when one of them finished. None could.

It never showed up with one request, or two, or five. It needed exactly the concurrency the test was
written to produce.

Fixed by making `findById` take an executor - the pool, or the client of a transaction already in
progress - and passing the client from inside the transaction. Every repository function that can be
called mid-transaction now takes one. `MeterService.usageFor` was cleaned up at the same time: it
was wrapping a read-only rollup in a transaction for no reason, holding a connection it did not need.

The general rule I did not know before: **a function running inside a transaction must never reach
for the pool.** Doing so is invisible under light load and deadlocks under real load.

### Decisions worth defending

- **The webhook route is registered before `express.json()` and uses `express.raw()`.** Stripe signs
  the exact bytes it sent; `express.json()` consumes the stream and discards them, and
  re-serialising `req.body` does not reproduce them (key order, whitespace, unicode escaping). Get
  this wrong and every genuine event fails verification, which looks exactly like a wrong secret.
- **Claim and apply happen in one transaction.** If applying fails, the claim rolls back with it, so
  the event is not marked processed and Stripe's retry can redo it. A claim committed separately
  would silently swallow the event whenever handling failed.
- **`ON CONFLICT DO NOTHING` for the webhook claim, rather than catching the unique violation.** The
  claim shares a transaction with the work; a raised constraint error would abort that transaction
  and every statement after it would fail with "current transaction is aborted". The idempotency
  keys in Phase 2 use try/catch instead, because there the claim is its own short transaction and
  the existing row has to be read back.
- **Unhandled event types return 200, not 404.** Stripe retries anything that is not acknowledged.
  Refusing events we will never handle would mean Stripe retrying them for days.
- **Unknown Stripe statuses map to `past_due`, not `active`.** Being wrong in the direction of
  blocking a request is recoverable; being wrong towards granting free access is not.
- **The success redirect grants nothing.** The plan changes only when the signed webhook is
  verified. A browser redirect is a claim by the client, not proof of payment.
- **The tests never touch Stripe.** A signature is HMAC-SHA256 over `timestamp.rawBody` keyed by the
  `whsec_` secret, so correctly-signed and deliberately-forged events are built locally. Offline,
  deterministic, and they run for anyone who clones the repo.

### Where AI helped

Wrote the service, repositories, route wiring and tests, and diagnosed the pool deadlock from the
symptom (a hang, with no output) rather than me having to bisect it.

### Still to do in this phase

One live Checkout in the browser, with a real test key and `stripe listen` running, to confirm the
end-to-end path outside the test suite. Everything else is verified.

### Gate

`npm test` - 96 passing, 0 failing, stable across three consecutive runs. Forged signature returns
400 and changes nothing; a replayed event is processed exactly once.

---

## Phase 3 (live run) - a webhook went missing, and that turned out to be the useful part

Ran a real Checkout in the browser with the `4242` test card. Stripe recorded it correctly:
`status: complete`, `payment_status: paid`, a customer and a subscription created at 19:29:26.

**Our database never saw it.** The plan stayed `free`. The newest row in
`processed_webhook_events` was from 19:12 - the synthetic `stripe trigger` from earlier.

What made this confusing is that nothing was broken. `stripe listen` was still running, same PID as
before. The server was up. Postgres was healthy. Firing a fresh `stripe trigger` landed in the
database within seconds. The pipe worked before the payment and after it, but not during.

The explanation: **`stripe listen` is a websocket, not a durable queue.** If the connection drops
and reconnects, events emitted during the gap are simply gone. The CLI does not backfill them, and
it does not warn you.

This is the single best argument I have for the reconciliation job, and I did not have to invent
the scenario - it happened by itself on the first real payment. A tenant paid, Stripe knew, and our
database disagreed. Nothing in the metering path would ever have noticed. That is precisely what a
nightly comparison against Stripe's view is for, and it is why the job is a requirement rather than
a nice-to-have.

### How it was recovered

`stripe events resend` failed with `resource-missing`, because it re-delivers to a *configured*
webhook endpoint and we only have a CLI listener. So the event was fetched from Stripe's API, signed
with the real `whsec_`, and POSTed to the server - which is exactly what the CLI does. The event was
genuine and the signature verification ran for real; only the transport was substituted.

Server response: `{"received":true,"duplicate":false,"applied":"upgraded to pro"}`.

### Verified live, not just in tests

- Acme: `free` -> `pro`, `stripe_customer_id` set, subscription row `active`.
- `GET /usage`: limits jumped from 1,000 / 100,000 / $1.00 to 50,000 / 5,000,000 / $100.00, while
  the recorded usage (1 call, 10,471 tokens) stayed exactly where it was. The plan changed; the
  ledger did not.
- Same event delivered again: `{"duplicate":true,"applied":null}`.
- Signature computed with the wrong secret: `400 invalid_signature`.

### A limitation to write into the README

Local webhook delivery is best-effort. In production the endpoint would be a real registered
webhook with Stripe's own retry schedule behind it; the CLI listener has neither. The reconciliation
job is what closes that gap in both cases.

---

## Phase 4 - cost rollups, the background job, and finalisation (2026-08-20)

The reconciliation job, month-rollover tests, a one-command Docker boot, and the submission pack
finished. 108 tests passing.

### Two bugs, and both were mine rather than the framework's

**1. Seeding silently undid a real payment.** `docker compose up` runs the seed on every start, and
the seed used `ON CONFLICT (api_key_hash) DO UPDATE SET plan_code = EXCLUDED.plan_code`. So
restarting the stack downgraded the tenant who had just paid, straight back to Free. I caught it
because the boot log printed `Acme Ltd [free]` seconds after I had watched Stripe upgrade it to Pro.

Changed to `DO NOTHING`. The principle: **seed data creates rows, it does not own their state
afterwards.** An upsert that rewrites live business state is not a seed, it is a reset.

**2. A global background job broke test isolation.** The reconciliation job walks *every* tenant
with a Stripe customer id. My tests called it with an empty fake Stripe, so it dutifully concluded
that every tenant in the database - including the real demo tenant, and every tenant belonging to
other test files - had no subscription, and cancelled them all.

The Phase 2 fix for test isolation was "scope each test to its own tenant", and that works when the
code under test is per-request. It does not work for a job whose whole purpose is to be global.

Fixed by giving `reconcile()` an optional `tenantIds` filter. That is not test-only scaffolding:
re-checking one customer after an incident is a real operational need, and it happens to make the
tests honest.

### The job proved itself on the way in

The lost webhook from Phase 3, plus bug 2 above, left the demo tenant reading `free / canceled`
while Stripe still had an active subscription. Running the job against live Stripe corrected it to
`pro / active` in one pass, and a second run corrected nothing - idempotent.

The same run threw 36 errors, all leftover test tenants with invented customer ids. That is the
resilience requirement demonstrated for real rather than in a fixture: 36 tenants failed, the run
finished, and the one tenant that needed fixing was fixed.

I did not plan to demonstrate the job this way. It happened because the thing it exists to catch
actually happened.

### Decisions worth defending

- **The month rollover is tested at one-second resolution.** A tenant filled to exactly its August
  limit is refused at 23:59:59 on 31 August and allowed at 00:00:00 on 1 September. Nothing changes
  but the clock. That test is only possible because `now()` is injectable.
- **`billing_period` is asserted at the row level**, not just through the API: two requests either
  side of midnight produce two rows filed under two different months. An event keeps the period it
  happened in, not the period you happen to ask in.
- **`docker compose up --build` is the entire run command.** It builds, waits for Postgres to be
  healthy, migrates, seeds, and serves. Migrations are recorded and skipped on re-run and the seed
  no longer clobbers anything, so restarting is genuinely safe.
- **`.dockerignore` excludes `.env`.** The image is built from a `COPY src ./src`, so secrets could
  not get baked in even by accident.
- **The reconciliation job returns a report rather than logging prose** - counts, drift entries,
  and errors. Same instinct as the run report in A9: a job that reports nothing can fail silently
  for weeks.

### Where AI helped

Wrote the job, the rollover and reconcile tests, the Docker setup, and the README run section. It
also spotted the seed-clobbering bug from one line of boot output that I would have scrolled past.

### Gate

`npm test` - 108 passing. `/usage` matches the pinned pricing tests. The background job runs, is
idempotent, and has been verified against live Stripe.

---

## Phase 5 - demo preparation (2026-08-21)

Wrote `src/db/seedDemo.js` and `DEMO.md`, and rehearsed the whole thing twice.

### The rehearsal caught a broken demo

First run through, the very first request returned `429` instead of `200`. The demo tenant was
seeded with 80,000... no, 88,000 tokens used, and a typical request reserves 13,200. 88,000 +
13,200 = 101,200, over the 100,000 limit. The boundary I wanted to demonstrate was already behind
me before I started.

It broke a second beat too, and that one is more interesting: because request 1 was refused, its
idempotency key was deleted - the deliberate behaviour from Phase 1 so that a tenant who upgrades
and retries is not served a stale rejection. So the follow-up "same key, different body" call was
treated as a brand new request and returned `200` where the script promised `422`. Correct system,
wrong script.

Reseeded at 80,000, which leaves room for exactly one request and refuses the second. The arithmetic
is now written into the seed file as a comment so nobody re-tunes it by guesswork.

Rehearsing is not optional for this. Both failures were in my staging, not my code, and I would
have found them live.

### Deliberate choices in the demo

- **Three of the five beats are refusals.** The brief says one failure handled gracefully beats ten
  happy paths, and the interesting behaviour in a billing system is what it refuses.
- **Two demo tenants, not one.** `Nearly Full Ltd` runs out of allowance (429) and
  `Nearly Broke Ltd` runs out of money (402), so the difference between the two status codes is
  shown rather than explained.
- **`npm run seed:demo` resets both to their starting line**, so the demo is repeatable. It is
  separate from the ordinary seed because it manufactures a specific situation rather than setting
  up a clean system.
- **The lost webhook is in the script as a fallback**, not hidden. If Stripe or the CLI misbehaves
  live, the answer is to run the reconciliation job and tell the story - which is a better story
  than the happy path was.

### Gate

Demo rehearsed twice end to end, all beats produce the output written in `DEMO.md`, and the whole
suite is green at 108.
