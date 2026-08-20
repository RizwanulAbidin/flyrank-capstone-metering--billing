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
