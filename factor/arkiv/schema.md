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

- put `faceValue` in the payload and every search becomes a client-side scan
  over every listing in the system;
- put a signature blob in attributes and you burn one of 32 slots on something
  nobody will ever filter by.

So the test for each field was simply: *would a financier ever put this in a
search box?* If yes, it is a typed attribute. If no, it goes in the payload.

## Entity kinds

`kind` is the first clause of every query. That is deliberate: it partitions the
namespace cheaply, and it means no query in this codebase is ever filter-less —
Arkiv throws `InvalidPredicateError` on a query with no predicates, so there is
no "match all" to fall back on.

### `listing` — the discovery index over an on-chain claim

| attribute | type | queryable because |
|---|---|---|
| `kind` | `str` | partition |
| `invoiceId` | `u256` | joins to the Fuji ERC-721 token id |
| `issuer` | `addr` | "everything Acme has listed" |
| `debtor` | `addr` | concentration risk — "am I overexposed to this debtor?" |
| `sector` | `str` | financiers have sector mandates |
| `faceValue` | `dec` | **range filter** — the reason this is `dec`, not `str` |
| `dueDate` | `u64` | **range filter** — horizon matching |
| `ratingBand` | `i32` | **range filter** — 1 (best) to 5 |
| `teaserRef` | `str` | Swarm ref of the *public* redacted summary |
| `docCommit` | `bytes32` | commitment to the encrypted full document |
| `claimContract` | `addr` | which deployment the asset lives in |
| `chainId` | `i32` | 43113 — makes the cross-chain link explicit |
| `ensName` | `str` | `acme.factor.eth` |
| `sold` | `bool` | lifecycle |

Payload: a human description and the teaser reference. Nothing here is
filterable and nothing here needs to be.

**Lifetime:** maturity plus a seven-day grace window. The index self-prunes — an
invoice nobody financed stops cluttering the market without a cleanup job.

### `bid` — an offer that cancels itself

| attribute | type | queryable because |
|---|---|---|
| `kind` | `str` | partition |
| `invoiceId` | `u256` | which claim this bids on |
| `financier` | `addr` | who is offering |
| `discountBps` | `i32` | **range filter** — the issuer's acceptance threshold |
| `offerPrice` | `dec` | what they will actually pay |
| `sector` | `str` | denormalised so sector queries need no join |
| `ensName` | `str` | resolves to a payout address and a sealing key |

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
| `invoiceId` | `u256` |
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

**Issuer, four clauses across four types** (`src/arkiv/bids.ts`):

```
kind        =  str('bid')
invoiceId   =  u256(id)
discountBps <= i32(maxBps)            range
$expiresAt  >  u64(currentBlock)      system attribute, range
```

**Financier, five clauses across five types** (`src/arkiv/listings.ts`):

```
kind        =  str('listing')
sold        =  bool(false)
sector      =  str('logistics')
faceValue   >= dec('5000')            range
dueDate     <= u64(horizon)           range
ratingBand  <= i32(3)                 range
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
  query that filters on it. We renamed `rating--band` to `ratingBand` early.
- **Durations drift.** `BLOCK_TIME` is a nominal 2 seconds and the docs are
  explicit that block production is not a clock, so a `fromSeconds(60)` lifetime
  is approximately a minute. The UI reads `$expiresAt` back rather than counting
  down from what it asked for.

## Ownership model

Listings and handovers are signed by the issuer; each bid is signed by its own
financier. That is not incidental — an Arkiv entity is owned by the wallet that
signed it, so using separate signers is what makes `$owner` / `ownedBy()` a
meaningful filter ("my live bids") instead of a constant.
