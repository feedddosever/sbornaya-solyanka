# Arkiv missions — what Factor claims, and the evidence

This is the "Arkiv evidence" artefact for the ETHRome 2026 Arkiv bounty
submission. Everything below was run against **Tiramisu (chain 7738577)** on
12 September 2026. Block numbers, transaction hashes and entity keys are real
and checkable.

Two missions are claimed: **02 Built to expire** and **03 Live wire**.
Mission 01 is explicitly *not* claimed — see the last section, because saying
so is more useful than a stretch.

> Arkiv's own note: *"Doing 3/3 does not pay three times, it puts you in three
> prize lines but you can only win once."* So this file aims to make two claims
> unarguable rather than three claims plausible.

Both missions can be re-run on demand by anyone with the repo:

```bash
python3 scripts/evidence-rpc.py    # Mission 02 — expiry, via JSON-RPC
node    scripts/evidence-ws.mjs    # Mission 03 — filtered subscription
npx tsx scripts/evidence.ts        # Mission 02, through the app's own query layer
```

The first two need no `node_modules` and no SDK: Python's stdlib plus `curl`,
and Node 22+'s built-in `WebSocket`. That is deliberate — see *Why the
witnesses are independent* below.

---

## Mission 02 — Built to expire

> **Done when:** something in your app changes because data expired on its own,
> not because a job deleted it (think of expiration as a feature, not as a nice
> 'add-on')

### What expires, and what changes because of it

A **bid** in Factor is an Arkiv entity with a short lifetime. There is no
cancel endpoint in this repository and no reaper job — grep for `deleteEntity`
and you will not find a call.

That is not a storage trick, it is the product:

- An invoice financier's quote is only honest for as long as their funding
  position holds. A quote that needs cancelling is a quote that was already
  stale, and every real trading venue ends up building expiry, withdrawal
  plumbing, or both.
- Factor writes the lifetime **into the quote**. A 4.5% offer good for 60
  seconds is an entity that exists for 30 blocks. Nobody withdraws it; it
  stops existing.
- What changes in the app when that happens: the bid leaves the book, the
  **best price the issuer sees changes**, and the accept button loses its
  target. The issuer's decision is made against quotes that are live *by
  construction* rather than by convention.

The queryable consequence is the part a Web2 database does not give you for
free. `$expiresAt` is a system attribute you can **filter on**, so "live bids"
is a predicate, not a `WHERE created_at > now() - interval` convention that
every client has to remember to apply. Forget the clause in Postgres and you
serve stale quotes; forget it here and the row is not there to serve.

### Evidence

One query, three executions, no delete call:

```
query : project = str('factor-invoice-market-ethrome-2026')
        AND kind = str('bid')
        AND invoice_id = u256(8889)
        AND discount_bps <= i32(10000)
        AND $expiresAt > u64(<current block>)

block 356093  write a bid, lifetime 40s
              entity 0x1f89e5fbeeb0569b35f4e625f3f50191b21fb2cdc66956d0b8ae9e8879e84412
              tx     0xa9235a9715f433f41bef77613b869e453512d89408236827e91ba9c149b07651
              createdAt 356095   expiresAt 356115   (+20 blocks = 40s exactly)

block 356097  query -> 1 bid     BEFORE
block 356116  query -> 0 bids    AFTER
block 356097  same query, atBlock=356097 -> 1 bid    still there historically

delete calls made: 0
```

**The third read is the one that closes the argument.** Without it, "the bid is
gone" is equally consistent with "the bid was never really indexed". The
point-in-time read shows the entity genuinely occupied the index at 356097 and
had left by 356116. Expiry is the only mechanism involved.

Note `expiresAt - createdAt = 20` blocks for a requested 40 seconds — exactly
the 2s block time, with no drift on this run. That is worth stating precisely
because the docs are explicit that block production is not a clock, so a
lifetime in seconds is a *request*, not a guarantee. Factor therefore renders
countdowns from the entity's own `expiresAt` height read back from the node,
never from the lifetime it asked for.

---

## Mission 03 — Live wire

> Build an app that uses Arkiv WebSocket subscriptions to react to entity
> changes. **Filter the events your app needs** and update the UI from the
> stream, **without a polling loop**.

### How the three requirements are met

**WebSocket subscriptions.** The app's read client uses viem's `webSocket()`
transport, not `http()`. This matters more than it looks: viem only opens
`eth_subscribe` when the transport can carry it, so the documented Live Events
example — which constructs the client with `http()` and defaults
`pollingInterval` to half a block — builds the polling implementation this
mission disqualifies. Reported as item 2 of `friction.md`.

**Filtered.** The subscription is narrowed to the storage engine's address and
to the entity-event topics the app acts on. Forty teams share this testnet;
subscribing unfiltered wakes the UI on strangers' writes. In the app the
callback set is narrowed further, to `created` / `deleted` / `expiryExtended` —
a patch to an unrelated entity is not a reason to re-read the bid book.

**Without a polling loop.** There is no `setInterval` in the app that touches
the network. The one interval that exists advances a local clock so countdowns
interpolate between updates; it issues no requests. The split is deliberate:
**the stream carries "something changed", the query carries "here is the
truth".** Replaying missed events would need `fromBlock`, which forces viem
back onto the polling path — so a dropped connection resyncs with a single
query instead, and the subscription stays a subscription.

### Evidence

```
socket : wss://rpc.tiramisu.db-chain.testnet.arkiv.network
filter : address = 0x4400000000000000000000000000000000000044
         topic0  = 0xb282d7c494b8899aa8015cd07be621530beb03409eb8c5e8fdc1411ba64356a5

socket open in 360ms
subscribed, id = 0x965a85243f3588fc0361a27067bdb4

write one bid (invoice 9065) to cause exactly one event
  entity 0x1cb82889c9374e8d01caa3947735d14359e932a6e59b6390edd8899443b68bb9
  tx     0x8ff0e3080024799eff152ce4890c535433dd4257cac9227beaf0f3880847411b

EVENT RECEIVED for our entity, block 356475
  arrived 3398ms after the write was submitted
  and 2126ms BEFORE the write's own HTTP response returned

GET requests issued while waiting : 0
other teams' events seen          : 3   (filtered out by key)
delivery                          : push
```

**The last measurement is the interesting one.** The event arrived over the
socket *before the HTTP response to the write that caused it*. A subscription
is not a faster poll — it is ahead of the writer's own round trip. No polling
interval reaches that, and neither does awaiting your own transaction.

The 3 unrelated events in a ~3 second window are also the honest case for
filtering: unfiltered, this UI would re-read on every stranger's write, roughly
once a second on a quiet testnet.

---

## Why the witnesses are independent

`scripts/evidence-rpc.py` and `scripts/evidence-ws.mjs` deliberately do **not**
use Factor's own read path, or even the Arkiv SDK. They speak JSON-RPC and raw
WebSocket directly.

That independence was not a stylistic choice; it was forced, and the story is
itself feedback. During development a half-deployed build had `schema.ts`
updated but `bids.ts` not, so the app **wrote** `snake_case` attribute names
while **querying** `camelCase` ones. Every write succeeded. Every read returned
nothing. No error was raised on either side, and the app reported an empty
market while the data sat in the index, perfectly readable.

A witness that shares the app's query layer cannot catch that. These two can,
and did. The underlying naming trap is `friction.md` item 1.

---

## Mission 01 — not claimed

> **Done when:** your app answers, from Arkiv, a question it answers today
> through a subgraph, Ponder or a Postgres pipeline, and its read path no longer
> calls the indexer.

Factor is new this weekend. There is no subgraph, no Ponder instance and no
Postgres pipeline that it stopped calling, so there is nothing here that was
decommissioned.

The honest version of the adjacent claim, which is *not* this mission: the bid
book and the discovery index are exactly the workload that would conventionally
be a subgraph over the `InvoiceClaim` events plus a Postgres table for the
off-chain quotes, and Factor's read path calls neither. But that is
"wouldn't have needed an indexer", not "turned one off", and the mission asks
for the second. Claiming it would be inventing an indexer in order to switch it
off.

---

## Where each judging criterion is answered

| Weight | Criterion | Where |
|---|---|---|
| 30% | **Why Arkiv / Web3 database?** | `README.md` → *Mutable state lives in Arkiv because the market needs a queryable set, not a pointer*; and the `$expiresAt`-as-predicate argument in Mission 02 above |
| 25% | **Technical execution** | Live demo; `schema.md`; the two re-runnable witnesses above; 23 passing contract tests including fuzz |
| 20% | **Usefulness & adoption** | `README.md` → *The problem* and *Where this goes next*, incl. the first-100-users route |
| 25% | **Arkiv feedback** | `friction.md` — 8 items, each with repro steps, plus the one-line fixes where the cause is a specific constant in the SDK |

### The 30% question, in one paragraph

Factor's market needs a **mutable, queryable set with per-row lifetimes**, and
that is the specific shape Arkiv provides and the alternatives do not. A
Postgres table gives the set and the queries but not verifiability, and its
expiry is a cron job somebody has to run. A Swarm feed gives verifiable,
mutable *pointers* — no number of feeds answers "unsold logistics invoices over
5,000 maturing inside my horizon, rated 3 or better", which is one predicate
here. An on-chain array gives verifiability and pays for every byte. The bytes
that matter — the invoice document — are on Swarm; the asset is an ERC-721 on
Avalanche; Arkiv is the index that makes either findable, and the expiry that
makes the quotes honest.

---

## Current state, stated plainly

| | |
|---|---|
| Arkiv writes | working — signer `0x2A058020fa86281b6695Fad49c302182ec8aeA34`, funded |
| Arkiv reads, direct | working — five-clause query verified above |
| Mission 02 | **verified**, reproducible |
| Mission 03 | **verified**, reproducible |
| The deployed market page | blocked — production is serving an intermediate commit whose `bids.ts` still queries `camelCase`. The fix is in `main`; it needs a build from `HEAD`, not a redeploy of the same commit. |

`GET /api/arkiv/health` reports the signer address, whether it is funded, and
whether every attribute name the build writes will be accepted by the engine —
the last check exists because of `friction.md` item 1, and it makes both the
naming trap and the half-deploy visible instead of silent.
