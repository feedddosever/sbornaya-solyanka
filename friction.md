# Arkiv feedback — Factor, ETHRome 2026

*What worked, what got in the way, and what I'd change.* Everything below was
reproduced against `@arkiv-network/sdk` on Tiramisu (chain 7738577) while
building [Factor](./README.md).

**A note on how this list was built, because it is itself feedback.** My first
draft contained five confident bug reports that turned out to be wrong — I had
been guessing documentation URLs (`/sdk/quickstart`, `/sdk/query`) that don't
exist in your information architecture, and reading 404s as broken docs. The
real paths (`/start-here/installation/`, `/typescript-sdk/live-events/`,
`/networks/tiramisu/`) serve fine, have a full API reference, and include
"Copy Markdown" and "Open in Claude" affordances that are genuinely better than
most SDK docs I've used. I deleted those items rather than ship them. What's
left is verified, with repro steps.

The single thing that would have prevented my whole wrong turn: **there is no
`sitemap.xml` or `llms.txt` at the docs root**, so a wrong guess at the URL
scheme fails silently instead of redirecting or suggesting. That is the one
documentation fix I'd prioritise.

---

## What got in the way

### 1. The Live Events example builds exactly the thing Mission 03 disqualifies

**Severity: high — this one costs you bounty entries.**

`docs.arkiv.network/typescript-sdk/live-events/` says `watchEntityEvents`
"polls the chain for new events", defaults `pollingInterval` to half a block,
and its Basic Usage snippet constructs the client with `http()`.

Mission 03 requires updating "from the stream, without a polling loop". So a
developer who follows the documented example literally has built the
disqualifying implementation, and nothing on the page tells them. The fact that
you need a **websocket transport** — and that viem only opens `eth_subscribe`
when the transport can carry it — is only discoverable from the
`watchEvent#poll-optional` link on the ETHRome hub page, which is not linked
from the SDK docs.

**Repro:** follow the Live Events Basic Usage snippet verbatim; observe repeated
`eth_getFilterChanges`/`eth_getLogs` rather than a subscription.

**Suggested fix:** show `webSocket()` in the Basic Usage snippet, or add a
callout: *"with an `http` transport this polls; pass a `webSocket` transport for
a real subscription."* Also state explicitly what `fromBlock` does to the
transport choice — the interaction between "replay history" and "stay on a
socket" is the actual hard part of Mission 03, and it is currently folklore.

### 2. `fromBlock` and socket delivery are mutually exclusive, and that has no guidance

Recovering from a dropped connection wants a replay; a replay sets `fromBlock`;
`fromBlock` forces polling. So the obvious reconnection strategy silently
converts a subscription back into a loop.

This is a real architectural fork and the docs don't acknowledge it. Factor's
answer (in `src/arkiv/watch.ts`) is to resubscribe with no `fromBlock` and close
the gap with a one-shot query instead — the socket carries "something changed",
the query carries "here is the truth". **Suggested fix:** document that pattern,
or say plainly that `watchEntityEvents` is at-most-once and callers must
reconcile.

### 3. No sort and no aggregate, which caps what the query layer can be

**Severity: medium — this is the thing stopping Factor from being real.**

Typed attributes with real comparison operators are the reason to choose Arkiv,
but there is no `orderBy` and no `count`. Factor's bid book therefore fetches a
page and ranks client-side (`src/arkiv/bids.ts`). At 50 rows that is fine; for
an actual order book it is wrong, because the best bid might be on page three
and `MAX_LIMIT` is 200.

I can't express "the cheapest live bid on this invoice" — which is the single
most natural question in the entire domain — as a query.

**Suggested fix:** `orderBy` on an indexed attribute would unlock a large class
of apps. A `count`-only query mode would be a strong second.

### 4. `ne` excludes entities missing the attribute, which is a silent correctness trap

`ne("sold", bool(true))` matches only entities where `sold` is *set* to
something else. Listings created before I added the attribute silently vanished
from the market — no error, no warning, just wrong results.

The correct form is `not(eq("sold", bool(true)))` or `not(exists("sold"))`.

**Repro:** create an entity without attribute `x`; query `ne("x", str("a"))`;
observe it is not returned.

**Suggested fix:** this distinction is in the source JSDoc, but it deserves a
callout box on the Querying Data page next to `ne` itself. It cost me ~40
minutes precisely because the query looked obviously right.

### 5. `--` in an attribute name writes fine, then corrupts queries

I named an attribute `rating--band`. The write succeeded. Every later query
filtering on it returned wrong results, because `--` opens a comment in the
query language and the rest of the predicate is discarded.

`validateAttributeName` / `isValidAttributeName` exist and I should have used
them — but the *consequence* is what makes this dangerous: the failure appears
at query time, in a different part of the codebase, looking like a query-engine
bug rather than a naming one.

**Suggested fix:** reject `--` at write time with an error that names the
reason ("`--` begins a comment in the query language"). Failing fast at the
write is strictly better than a silent read-time corruption.

### 6. Duration helpers read as wall-clock but aren't

`ExpirationTime.fromSeconds(60)` resolves to 30 blocks, which is 60 seconds only
if blocks are exactly 2s — and the docs are careful to say block production is
not a clock. That honesty is good; the API naming quietly undoes it, because
every helper is named in time units.

`getBlockTiming` exists, which is the right primitive — it just isn't mentioned
anywhere near the duration helpers.

**Suggested fix:** cross-link `getBlockTiming` from the expiry helpers, or have
them return the resolved target block so the drift is visible at the call site.
Factor now reads `$expiresAt` back and renders countdowns from block height
rather than from what it requested.

### 7. `fromSeconds` rejects odd numbers without saying why

`ExpirationTime.fromSeconds(45)` throws. The constraint (a positive multiple of
the 2-second block time) is reasonable, but it leaks block time into an API
presented in seconds, and the error doesn't say "must be even". Minor, but it's
a 30-second confusion for every new user.

---

## What worked

Worth recording, because a report with no positives is less useful to you.

- **`.atBlock()` is the best thing in the SDK and it is undersold.** Point-in-time
  historic reads turned "prove the data expired on its own" from a screen
  recording into a two-line script that runs identically on demand
  (`scripts/evidence.ts`: one query, two block heights, present then absent).
  Nothing in the Mission 02 brief mentions it, and it is the single most
  compelling way to satisfy that mission's evidence requirement. Lead with it.
- **The query builder composes cleanly.** `.where(eq(...), gte(...))` ANDing
  together, with `ownedBy()` as sugar for `$owner`, reads well and the types
  caught two mistakes before runtime.
- **Typed attributes are the actual differentiator.** `dec` for money instead of
  a stringly-typed amount is the right call, and range filters over `dec`/`u64`
  are what make an index worth having over a key-value store.
- **Being a viem client** meant accounts, transports and error handling were
  already familiar — zero new concepts before the first entity.
- **The docs' "Copy Markdown" / "Open in Claude" buttons** are excellent and rare.
  Pair them with an `llms.txt` and the programmatic story would be best-in-class.
- **`predictEntityKey` / `randomSalt`** are a nice surprise — being able to know
  an entity's key before creating it opens coordination patterns I didn't expect
  and didn't have time to use.

---

## One process note, not about the SDK

The judging criteria on `hub.arkiv.network/ethrome` and the ones on the ETHRome
prizes page are materially different sets — the ETHRome page lists query depth,
evidence, schema trade-offs, friction and craft; your page lists why-Arkiv,
technical execution, usefulness/adoption and feedback. I built against your
page, since the ETHRome manual says yours is authoritative and kept current.
Worth reconciling before Sunday so nobody optimises for the wrong rubric.

Your page also links its own submission form, which the ETHRome page does not
mention. I have filled in both.
