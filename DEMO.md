# The six-minute demo

Rehearsed end to end. Every number below was produced by actually running it, not estimated.

The brief says a demo that shows **one failure handled gracefully** beats ten happy paths, so three
of the five beats are refusals.

---

## Before you start

Three terminals, in this order.

**Terminal 1 — the stack**
```
docker compose up --build
```
Wait for `metering-billing listening on port 3000`.

**Terminal 2 — the webhook pipe** (only needed for beat 3)
```
$env:Path += ";$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Stripe.StripeCli_Microsoft.Winget.Source_8wekyb3d8bbwe"
stripe listen --forward-to localhost:3000/webhooks/stripe
```

**The panel** — open **http://localhost:3000/dashboard** and pick *Nearly Full Ltd*.

Run beats 1 and 2 from the panel rather than curl: the buttons do the same thing and the meters make
it visible. The curl commands below are kept as the fallback if a projector hates the browser.

**Terminal 3 — where you type** — put the demo tenants on their starting line:
```
npm run seed:demo
```

```
demo: Nearly Full Ltd  - token quota is one request away
        starting: 80000 tokens, 24000 micros used
demo: Nearly Broke Ltd - spend cap is one request away
        starting: 2000 tokens, 980000 micros used
```

Re-running `npm run seed:demo` resets both, so you can rehearse as many times as you like.

Set these once in Terminal 3 to keep the commands short:

```powershell
$FULL  = "Authorization: Bearer sk_demo_nearlyfull_00000000000"
$BROKE = "Authorization: Bearer sk_demo_nearlybroke_0000000000"
$ACME  = "Authorization: Bearer sk_demo_acme_0000000000000000"
$REQ   = '{"input_tokens":1200,"cached_input_tokens":8000,"max_output_tokens":2000}'
```

---

## Beat 1 — the boundary (~70s)

*In the panel: press **Send a request**, then press it again.*

> "This tenant is on the Free plan: 1,000 API calls, 100,000 tokens, and a $1.00 spend cap a month.
> They have used 80,000 tokens. Watch what happens as they run out."

**One request that fits:**
```
curl -X POST localhost:3000/generate -H $FULL -H "Idempotency-Key: demo-a" \
  -H "Content-Type: application/json" -d $REQ
```
→ `200`

**The next one:**
```
curl -X POST localhost:3000/generate -H $FULL -H "Idempotency-Key: demo-b" \
  -H "Content-Type: application/json" -d $REQ
```
→ `429`

```json
{
  "error": "Monthly token quota would be exceeded",
  "code": "token_quota_exceeded",
  "details": { "limit": "token_limit", "cap": 100000, "committed": 90755,
               "held": 0, "requested": 13200, "would_reach": 103955 }
}
```

> "It does not just say no. It says which limit, what has been used, what was asked for, and where
> that would land. And it is **all-or-nothing** — there were 9,245 tokens left, and it did not
> quietly consume them. Nothing was recorded."

---

## Beat 2 — the retry does not double-charge (~80s)

*In the panel: **Retry with the same key**, then **Reuse the key, change the body**. Watch the meters
stay exactly where they are while the ledger gains rows.*

> "Now the part billing systems get sued over. The client's network drops and it retries."

```
curl -X POST localhost:3000/generate -H $FULL -H "Idempotency-Key: demo-a" \
  -H "Content-Type: application/json" -d $REQ
```
→ `200`, header `Idempotent-Replay: true` — the original response, byte for byte.

**Show the ledger:**
```
docker compose exec db psql -U postgres -d metering \
  -c "SELECT usage_type, quantity FROM usage_events e JOIN tenants t ON t.id=e.tenant_id
      WHERE t.name='Nearly Full Ltd' ORDER BY occurred_at;"
```

```
 usage_type | quantity
------------+----------
 tokens     |    80000     <- the seeded starting point
 api_call   |        1     <- ONE call, not two
 tokens     |    10755
```

> "One event. The guarantee is not a check in my code — it is a `UNIQUE` constraint on
> `(tenant_id, endpoint, key)`. The second request tries to insert, the database refuses it, and
> that refusal is what tells us someone got here first. A read-then-insert loses that race."

**Then the bug case:**
```
curl -X POST localhost:3000/generate -H $FULL -H "Idempotency-Key: demo-a" \
  -H "Content-Type: application/json" -d '{"input_tokens":5,"cached_input_tokens":5,"max_output_tokens":5}'
```
→ `422 idempotency_key_reused`

> "Same key, different request. That is a client bug, and quietly replaying an unrelated response
> would hide it. The IETF idempotency-key draft says return 422, so it does."

---

## Beat 3 — money is a different limit from allowance (~40s)

*In the panel: switch the tenant dropdown to **Nearly Broke Ltd** and press **Send a request**. The
tokens meter is nearly empty and the spend meter is nearly full.*

```
curl -X POST localhost:3000/generate -H $BROKE -H "Idempotency-Key: broke-1" \
  -H "Content-Type: application/json" -d $REQ
```
→ `402`

```
code        : spend_cap_exceeded
cap         : 1000000 micros ($1.00)
committed   :  980000
would reach : 1047000
```

> "This tenant has 98,000 tokens left — plenty of allowance. What they have run out of is **money**.
> That is a 402, not a 429: 429 means an allowance is used up and waiting fixes it; 402 means a plan
> or payment problem and upgrading fixes it. Two different answers to two different questions."

---

## Beat 4 — the upgrade, live (~90s)

```
curl -X POST localhost:3000/billing/checkout -H $ACME
```

Open the returned URL, pay with `4242 4242 4242 4242`, any future expiry, any CVC.

Browser lands on a small JSON page:

> "Notice this page grants nothing. It says the plan updates when the signed webhook is verified.
> A browser redirect is a claim by the client, not proof of payment."

Watch Terminal 2 show `checkout.session.completed`, then:

```
curl localhost:3000/usage -H $ACME
```
→ `plan: pro`, limits now **50,000 calls / 5,000,000 tokens / $100.00**.

### If the webhook does not arrive

This happened for real during development, and it is worth showing rather than hiding:

```
npm run reconcile
```

> "`stripe listen` is a websocket, not a durable queue — if it blips, events in the gap are gone.
> That is not hypothetical, it happened to me on the first real payment: the customer had paid,
> Stripe knew, my database disagreed, and nothing in the request path would ever have noticed.
> This nightly job asks Stripe directly and corrects the drift. It is also why the job exists at
> all rather than being a checkbox."

---

## Beat 5 — forgery and replay (~50s)

**A forged webhook:**
```
curl -X POST localhost:3000/webhooks/stripe -H "Stripe-Signature: t=1,v1=deadbeef" \
  -H "Content-Type: application/json" \
  -d '{"id":"evt_forged","type":"checkout.session.completed","data":{"object":{}}}'
```
→ `400 invalid_signature`, and nothing changes.

> "Verification happens on the raw bytes, before the body is even read. Which is why that route is
> registered above `express.json()` — the JSON parser throws the raw bytes away, and re-serialising
> them does not reproduce what Stripe signed."

**Replay:** show the tests rather than fighting the CLI live:
```
npm test
```
```
ok - the same event delivered twice is processed exactly once
ok - ten simultaneous deliveries of one event are processed exactly once
ok - a forged signature is rejected with 400 and changes nothing
ok - a tampered payload with a real signature is rejected
# tests 109
# pass 109
# fail 0
```

> "Those webhook tests generate their own Stripe signatures locally, so they run offline on any
> machine that clones this repo."

---

## Beat 6 — the close (~30s)

```
curl localhost:3000/usage -H $FULL
```

Point at `used`, `held`, `remaining`, and `cost_micros`, then:

> "Money is stored as integer micros — millionths of a dollar — because at $3.00 per million tokens
> one token costs 3 micros, which would round to zero in cents and vanish. Cached input is priced
> at a tenth of fresh input, and reasoning tokens bill at the output rate, so the categories cannot
> be summed and multiplied by one number. All of it is pinned by tests to exact integers."

**Closing line:**

> "Usage, money, and customer access stay correct under retries, failures, and real-world
> conditions."

---

## Timing

| Beat | Target |
|---|---|
| 1 · boundary | 70s |
| 2 · retry, replay, 422 | 80s |
| 3 · spend cap | 40s |
| 4 · live upgrade | 90s |
| 5 · forgery + tests | 50s |
| 6 · close | 30s |
| | **~6 min** |

Beat 4 is the only one that depends on the internet. If Stripe or the CLI misbehaves on the day,
run `npm run reconcile` and tell the story of the lost webhook instead — it is a better story
anyway.
