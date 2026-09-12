# Arkiv schema — Factor

Draft produced at the Friday workshop, revised as the build went on.

## The decision this whole file encodes

**Anything a user filters on is an attribute. Everything else is payload.**

(Scoring note: the ETHRome prizes page describes an Arkiv rubric with a
20-point "fit and trade-offs" line. The criteria published on
`hub.arkiv.network/ethrome` are a different set — why-Arkiv 30%, technical
execution 25%, usefulness/adoption 20%, feedback 25% — and the ETHRome manual
says the sponsor's own page is authoritative. This document is written to
answer the "why Arkiv and not a Web2 database" question, since that is the
larger slice either way.)

Attributes are indexed and queryable; payload is not. There are only 32
attribute slots per entity and 128 KB of payload, so both directions of that
trade are real:

- put `face_value` in the payload and every search becomes a client-side scan
  over every listing in the system;
- put a signature blob in attributes and you burn one of 32 slots on something
  nobody will ever filter by.

So the test for each field was simply: *would a financier ever put this in a
search box?* If yes, it is a typed attribute. If no, it goes in the payload.

## The project attribute, before anything else

Arkiv's best-practices guide opens with a requirement, not a suggestion:

> All entities in Arkiv are public and stored in a shared database. Every
> project **must** define a unique project attribute and include it on every
> entity. Without a project attribute, your queries can return data from other
> projects, and other projects can see yours.

Every Factor entity therefore carries:

```
project = str('factor-invoice-market-ethrome-2026')
```

and **every** query leads with `eq(PROJECT.key, str(PROJECT.value))`. This is
not hygiene theatre — forty builders are writing to the same Tiramisu testnet
this weekend, and a book filtered only on `kind = str('bid')` would happily
fill with another team's rows. The value is deliberately long: `factor` alone
is a common word and a plausible name for somebody else's project.

Defined once, in `src/arkiv/project.ts`, and imported everywhere. It is the
first clause of the predicate rather than an afterthought.

## Compliance with Arkiv's published best practices

| # | Practice | Factor |
|---|---|---|
| 1 | Always use a project attribute | `src/arkiv/project.ts`, on every entity and every query |
| 2 | Separate read and write clients | reads via `createPublicClient`; writes only in API routes with server-held keys |
| 3 | Design attributes for queryability | every filterable field is a typed attribute; signatures stay in payload |
| 6 | Right-size expiration | bids 60s, listings maturity + 7d grace, handovers 10m |
| 7 | Never expose private keys | signing keys are server-side only, never `NEXT_PUBLIC_*` |
| 9 | Use numeric types for numeric data | `dec` for money, `u64` for timestamps, `i32` for bands |
| 10 | Model related data with shared attributes | `invoice_id` links bid → listing → the Fuji token id |
| 11 | Understand `$owner` vs `$creator` | **deliberately not relied on** — signing keys are server-side, so `$owner` is Factor's key, not the financier's. Whose bid it is comes from the `financier` attribute. See below. |

## Entity kinds

`kind` is the first clause of every query. That is deliberate: it partitions the
namespace cheaply, and it means no query in this codebase is ever filter-less —
Arkiv throws `InvalidPredicateError` on a query with no predicates, so there is
no "match all" to fall back on.

### `listing` — the discovery index over an on-chain claim

| attribute | type | queryable because |
|---|---|---|
| `kind` | `str` | partition |
| `invoice_id` | `u256` | joins to the Fuji ERC-721 token id |
| `issuer` | `addr` | "everything Acme has listed" |
| `debtor` | `addr` | concentration risk — "am I overexposed to this debtor?" |
| `sector` | `str` | financiers have sector mandates |
| `face_value` | `dec` | **range filter** — the reason this is `dec`, not `str` |
| `due_date` | `u64` | **range filter** — horizon matching |
| `rating_band` | `i32` | **range filter** — 1 (best) to 5 |
| `teaser_ref` | `str` | Swarm ref of the *public* redacted summary |
| `doc_commit` | `bytes32` | commitment to the encrypted full document |
| `claim_contract` | `addr` | which deployment the asset lives in |
| `chain_id` | `i32` | 43113 — makes the cross-chain link explicit |
| `ens_name` | `str` | `acme.factor.eth` |
| `sold` | `bool` | lifecycle |

Payload: a human description and the teaser reference. Nothing here is
filterable and nothing here needs to be.

**Lifetime:** maturity plus a seven-day grace window. The index self-prunes — an
invoice nobody financed stops cluttering the market without a cleanup job.

### `bid` — an offer that cancels itself

| attribute | type | queryable because |
|---|---|---|
| `kind` | `str` | partition |
| `invoice_id` | `u256` | which claim this bids on |
| `financier` | `addr` | who is offering |
| `discount_bps` | `i32` | **range filter** — the issuer's acceptance threshold |
| `offer_price` | `dec` | what they will actually pay |
| `sector` | `str` | denormalised so sector queries need no join |
| `ens_name` | `str` | resolves to a payout address and a sealing key |

Payload: the signed quote blob and a posting timestamp.

**Lifetime: 60 seconds, and this is the product.** There is no cancel endpoint
in this repository because a stale quote stops existing on its own. A financier
who wants to stay in the book re-posts; one who walks away leaves nothing
behind. Expiry is not a cleanup strategy bolted onto a cache — it is the
definition of a live quote.

### `handover` — the sealed document delivery

| attribute | type |
|---|---|
| `kind` | `str` |
| `invoice_id` | `u256` |
| `recipient` | `addr` |

Payload: the ECIES ciphertext of the encrypted-document reference, sealed to the
buyer's ENSv2 `pubkey` record. **Lifetime 10 minutes.**

The plaintext reference is never written to Arkiv, and this is the most
important line in the schema. An encrypted Swarm reference is 128 hex characters
*with its decryption key embedded* — the reference is the capability — and Arkiv
entities are public and verifiable by design. Arkiv's documentation says plainly
that it is not a confidentiality layer, so a commitment goes in the index and
the capability is sealed to exactly one key.

## The queries that justify the shape

**Issuer, five clauses across four types** (`src/arkiv/bids.ts`):

```
project     =  str('factor-invoice-market-ethrome-2026')
kind        =  str('bid')
invoice_id   =  u256(id)
discount_bps <= i32(maxBps)            range
$expiresAt  >  u64(currentBlock)      system attribute, range
```

**Financier, seven clauses across five types** (`src/arkiv/listings.ts`):

```
project     =  str('factor-invoice-market-ethrome-2026')
kind        =  str('listing')
sold        =  bool(false)
sector      =  str('logistics')
face_value  >= dec('5000')            range
due_date    <= u64(horizon)           range
rating_band <= i32(3)                 range
```

Every clause maps to a control in the UI, so the interface *is* the query
builder rather than a decorative wrapper over a fetch-by-id.

## What we hit along the way

- **No `ORDER BY` and no `COUNT`.** Bids are ranked client-side after fetching a
  page. Fine at 50 rows, wrong for a real book. See `friction.md`.
- **`MAX_LIMIT` is 200** and cursors are bound to an exact query/block/selection,
  so they cannot be reused across a modified builder.
- **`$createdAt` is not queryable** — only `$key`, `$owner`, `$creator` and
  `$expiresAt` are. "Newest first" therefore isn't expressible; we filter on
  `$expiresAt` instead, which happens to be the more meaningful question anyway.
- **`ne` is not the negation you want.** `ne("sold", bool(true))` silently skips
  entities where `sold` was never set. Use `not(eq(...))` or `not(exists(...))`.
- **Attribute names cannot contain `--`.** It opens a comment in the query
  language, so such a name writes successfully and then silently corrupts every
  query that filters on it. We renamed `rating--band` to `ratingBand` early — and then had to rename it
  again to `rating_band`, because the node rejects uppercase after the first
  character even though the SDK's own `NAME_RE` permits it. Two naming rules,
  neither of them in the docs. See friction.md item 1.
- **Durations drift.** `BLOCK_TIME` is a nominal 2 seconds and the docs are
  explicit that block production is not a clock, so a `fromSeconds(60)` lifetime
  is approximately a minute. The UI reads `$expiresAt` back rather than counting
  down from what it asked for.

## Ownership model, stated honestly

Arkiv's best practice #11 asks you to understand `$owner` versus `$creator`.
Here is the honest answer for Factor, which is not the flattering one.

`$owner` is the wallet that **signed** the entity. Factor's signing keys live
server-side, because best practice #7 says never expose private keys to a
browser. So `$owner` is *Factor's* key — never the financier's wallet. That is
true no matter how many keys the deployment holds: running three keys instead
of one would only hide the fact behind a plausible-looking `ownedBy()` call.

So the question "whose bid is this?" is answered by the **`financier`
attribute**, which is precisely why it is an attribute and not inferred from
ownership. `ownedBy()` answers a different question — "which of my server keys
wrote this row" — and Factor does not pretend otherwise. Both queries exist
side by side in `src/arkiv/bids.ts` (`myLiveBids` and `bidsSignedBy`), and the
gap between them *is* the trade-off.

**Factor is therefore a custodial index writer.** One funded Tiramisu key
writes every row. The consequence is real: a financier cannot prove to a third
party that a bid was theirs, because they never signed it.

Two ways to close that, neither done here:

1. **The financier signs.** Their browser holds an Arkiv key and creates the
   bid itself. `$owner` then genuinely is them, `ownedBy()` becomes meaningful,
   and Factor stops being trusted for authorship. This is the version Arkiv's
   ownership model is built for.
2. **`changeOwnership` after the write.** Factor creates the bid and transfers
   ownership to the financier's address, which needs their address but not
   their key. Costs a second transaction per bid, and the app is still trusted
   for the instant in between.

Option 1 is the right answer. It was not built because the demo signs on behalf
of two stand-in financiers, and handing a browser a funded key for a hackathon
demo would have been the wrong trade — but the limitation is architectural, not
cosmetic, and it belongs in this document rather than in a footnote.
