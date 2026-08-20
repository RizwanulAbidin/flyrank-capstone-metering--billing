# Usage Metering & Billing Engine

> **Status: Phase 0 of 5 — repo and test foundation.** The service itself is not built yet.
> This README grows one section per phase; sections marked _pending_ are not yet true.

The backend service that answers the three questions every SaaS product has to answer about a
customer: **how much have they used, what does it cost, and are they allowed to do this next
thing?**

FlyRank internship backend-track capstone.

## What it will do

- **Meter** every billable action to a tenant, exactly once, even when the client retries.
- **Enforce** the tenant's plan quota *before* the action runs — and refuse honestly when it will not fit.
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

_Pending — Phase 1._

## Money

Every monetary value in this system is an **integer number of micros** (millionths of a dollar).
Never a float, never a decimal string.

Micros rather than cents because token prices are much smaller than a cent: at $3.00 per million
input tokens a single token costs 3 micros, which would round to zero cents and vanish.

Rounding happens in exactly one place — `costMicros` in [`src/money.js`](src/money.js) — and is
pinned by tests. See [`test/money.test.js`](test/money.test.js), including the one-line test that
documents why floats are not an option.

## Data model

_Pending — Phase 1._

## API

_Pending — Phase 2._

## Running it

_Pending — Phase 2._ For now:

```
npm test
```

## Policies

_Pending — Phase 1._ These will be stated here in full, each with a test that enforces it:
the all-or-nothing quota boundary, what counts toward the token quota, reservation expiry, and
which status code means what.

## Limitations

_Pending — Phase 4._ Will include the deliberate non-goal (no invoicing, proration, or overage
billing) and the auditability work not taken on: effective-dated pricing, an append-only ledger
with reversals, and a `GET /usage/explain` endpoint.

## Repository files

| File | What it is |
|---|---|
| `capstone.yaml` | Manifest the evaluator reads: run, seed, test, base URL, endpoints |
| `EVIDENCE.md` | One pasted proof per Definition-of-Done checkbox |
| `BUILDLOG.md` | Honest log of where AI helped and where it was wrong |
| `.env.example` | Every environment variable, with placeholder values |
