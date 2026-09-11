# Factor

**Turn an unpaid invoice into a claim you can sell in minutes — with the document private, the policy enforced on-chain, and the offers expiring like real quotes.**

---

## The problem

A small business delivers work in March and gets paid in June. For those ninety days it is lending its customer the money, interest-free, out of its own working capital. Invoice factoring exists to close that gap, but it is built for companies large enough to be worth underwriting: paperwork, a relationship manager, days of turnaround, and a minimum ticket that rules out most of the businesses that need it.

The parts that actually make factoring slow are all coordination problems. Who is allowed to buy this claim? Is the offer I was quoted yesterday still good? How do I show you the invoice without publishing my customer list? Who gets paid when the debtor finally settles?

Factor does those four things in four places, each chosen because nothing else can do its job:

| Layer | Does | Why it has to be here |
|---|---|---|
| **Avalanche Fuji** | Invoice claim, eligibility policy, maturity rule, settlement | The only layer that can hold value and **revert** a transfer that breaks a rule |
| **Arkiv** | The bid book, and discovery | The only layer you can ask *"unsold logistics invoices over 5,000 maturing inside my horizon"* — and the only one where stale quotes vanish with no keeper |
| **Swarm** | The invoice document, encrypted, owned by the issuer | The only layer that holds a real 2MB PDF, and the only one where the business keeps its own file |
| **ENSv2** | `acme.factor.eth` — payout address, sealing key, delegated accountant | The only layer that makes a counterparty addressable with *scoped* authority |

The design in one sentence: **the bid is off-chain because it expires; the execution is on-chain because it moves money.** A financier's offer is an Arkiv entity with a 60-second lifetime, so there is no cancel endpoint anywhere in this repository — a stale quote simply stops existing. When the issuer accepts, Fuji executes and the transaction records the Arkiv entity key of the exact bid it filled, so the two systems can always be reconciled.

---

## What actually runs

```
Acme signs in with a passkey              → Swarm ID, no wallet, no seed phrase
  uploads invoice.pdf (encrypted)         → Swarm, 128-char ref kept secret
  uploads a redacted teaser (public)      → Swarm, ref published for discovery
  issues the claim on Fuji                → docHash = keccak256(encrypted ref)
  publishes a listing                     → Arkiv, queryable, self-pruning

Financiers discover it                    → 5-clause compound Arkiv query
  post bids with 60s lifetimes            → Arkiv, expiry is the cancel mechanism
  one bid expires, untouched               → no delete call, no reaper job

Acme accepts the survivor                 → Fuji sell(), records the Arkiv bid key
  an ineligible buyer is rejected          → reverts in the ERC-721 transfer hook
  the document is sealed to the buyer      → ECIES to their ENSv2 pubkey record

The debtor settles at maturity             → holder paid face value, claim burned
```

---

## Architecture notes worth reading before the code

### Eligibility is plain Solidity, and that is correct

Avalanche's `TxAllowList` / `ContractDeployerAllowList` precompiles are **Subnet-EVM genesis features and do not exist on Fuji C-Chain**. Since this is a C-Chain deployment with no custom L1, the transfer policy is a `mapping(address => bool)` checked in OpenZeppelin v5's `_update` hook. That is the right implementation for this chain, not a shortcut — and it keeps the engineering budget on the settlement flow instead.

### The document could have leaked, and nearly did

The obvious design is to encrypt the invoice and put the Swarm reference in the Arkiv listing. **That publishes every invoice in the system.** An encrypted Swarm reference is 128 hex characters *with the decryption key embedded* — the reference is the capability — and Arkiv entities are public and verifiable by design. Arkiv's own documentation says plainly that it is not a confidentiality layer.

So the document flow splits in three:

1. a **public redacted teaser** (amount band, sector, due month, no counterparty names) is uploaded unencrypted and its reference goes in the listing — this is what powers discovery;
2. the **full invoice** is uploaded encrypted and its reference is never published anywhere;
3. `keccak256(reference)` is committed on Fuji as `docHash` — public proof the document exists and has not changed, revealing nothing.

On sale, the issuer reads the buyer's public key **from their ENSv2 `pubkey` resolver record**, seals the reference to it (ECIES: ephemeral secp256k1 ECDH → HKDF-SHA256 → XChaCha20-Poly1305), and posts the *ciphertext* as a ten-minute Arkiv entity. Only the buyer can open it. See `src/swarm/seal.ts`.

### Mutable state lives in Arkiv because the market needs a queryable set, not a pointer

An earlier draft of this README claimed Swarm feeds and ACT require a running Bee node and are unavailable to a browser app. **That was wrong**, and it is worth correcting rather than quietly deleting: verified against the v0.4.0 source, `SwarmIdClient` exposes sequential and epoch feeds, SOC readers and writers, GSOC, chunk-level upload/download, and the full ACT surface (`actUploadData`, `actAddGrantees`) — all without a node.

So the division of labour still holds, but for a better reason. A feed gives you a mutable **pointer**; the market needs a mutable, **queryable set**. *"Unsold logistics invoices over 5,000 maturing inside ninety days, rated 3 or better"* is a six-clause compound filter over typed attributes, and no number of feeds answers it — you would be rebuilding an index by hand. Arkiv answers it in one query, and hands you native expiry for the bid book on top. That is the honest case for both layers.

One consequence worth knowing: since ACT *is* available, `actUploadData(data, grantees)` is a viable native alternative to the custom ECIES handover in `src/swarm/seal.ts`. Factor keeps the ECIES path because it seals to the buyer's **ENSv2 `pubkey` record**, which makes the ENS layer load-bearing instead of cosmetic — but ACT is the more idiomatic Swarm answer and the trade is a real one.

### Three chains, one demo

| Chain | ID | Signed by |
|---|---|---|
| Avalanche Fuji C-Chain | 43113 | the user's browser wallet |
| Arkiv Tiramisu | 7738577 | in-app signers (two, so `$owner` means something) |
| Ethereum Sepolia | 11155111 | a pre-run setup script |

Nobody is asked to switch networks during the demo.

---

## Run it

```bash
# 1. contracts
cd contracts
forge test -vv                      # 23 tests, incl. fuzz over eligibility + settlement
forge script script/Deploy.s.sol --rpc-url fuji --broadcast -vvv

# 2. app
cp .env.example .env.local          # paste the deployed addresses
npm install
npm run dev

# 3. ENSv2 (one-time, before demoing)
npx tsx scripts/ens-setup.ts

# 4. the Mission 02 proof, runnable on demand
npx tsx scripts/evidence.ts
```

**Funding, all of which has latency — do it first:** Fuji AVAX from `core.app/tools/testnet-faucet` (needs a mainnet AVAX balance or an Avalanche Guild coupon; 2 AVAX per 24h), Arkiv GLM from `hub.arkiv.network`, Sepolia ETH **plus MockUSDC** (the ENSv2 ETHRegistrar charges MockUSDC, not ETH).

---

## Deployed addresses

| What | Chain | Address |
|---|---|---|
| `InvoiceClaim` | Fuji 43113 | `TODO after deploy` |
| `FUSD` (test stablecoin, 6dp) | Fuji 43113 | `TODO after deploy` |
| UserRegistry (ENSv2) | Sepolia | `TODO after ens-setup` |
| PermissionedResolver | Sepolia | `TODO after ens-setup` |

Example transactions: `TODO — issue / sell / rejected transfer / settle`

---

## Bounties

**Arkiv** — Missions 02 and 03, judged against the criteria on `hub.arkiv.network/ethrome` (which the ETHRome manual designates authoritative).

*Why Arkiv and not Postgres (their 30%).* Three things here are impossible on a Web2 database. **Expiry as a data property**: a bid's validity *is* its lifetime, so there is no cancel endpoint and no reaper job in this codebase — a stale quote stops existing, and no cron job can be misconfigured to leave one live. **Per-entity ownership by signature**: each bid is owned by the wallet that signed it, so "my live bids" is `ownedBy()` rather than a `user_id` column the server has to be trusted to enforce. **Point-in-time historic reads**: `.atBlock()` lets anyone re-run today's query against last Tuesday's state and get a verifiable answer, which is what makes a bid book auditable rather than merely logged. A Postgres bid book can imitate the first with a TTL job and the second with a column; it cannot give a counterparty a reason to believe either one.

*Mission 02 (Built to expire).* Bids expire on their own. Evidence via `scripts/evidence.ts` — one identical query at two block heights, present then absent, zero delete calls.

*Mission 03 (Live wire).* `src/arkiv/watch.ts` uses `watchEntityEvents` over a **websocket transport** with no `fromBlock`. Both details matter: the documented example uses `http()` and the page itself says it polls, so following it literally builds the loop the mission excludes. Reconnection resyncs with a query rather than a replay, because `fromBlock` would force polling back on.

*Usefulness and adoption (their 20%).* The user is a 5-50 person business that invoices on 60-90 day terms and finances that gap out of its own working capital — the segment traditional factoring prices out. First hundred users would come through the accountants and bookkeepers who already see these invoices: one bookkeeping practice carries dozens of SMEs, and Factor's ENSv2 role delegation is built for exactly that relationship, letting a practice manage clients' records without holding their payout keys. The financier side is the harder half and I won't pretend otherwise.

*Feedback (their 25%).* [`friction.md`](./friction.md) — seven reproducible items with repro steps, plus what worked. Schema rationale in [`arkiv/schema.md`](./arkiv/schema.md).

**Swarm** — Real uploads and real retrieval through Swarm ID with passkey sign-in; the issuer's document is encrypted and stays theirs. Bee-js is not used because Swarm ID removes the node from the critical path entirely.

**Team1 Italy — Track B** (Tokenized Assets: Rules to Settlement). Asset rule: no transfers at or after maturity. Transfer policy: eligibility enforced in the ERC-721 hook. Settlement: the debtor pays face value to the current holder and the claim burns. All three visible in one contract's event log on Snowtrace.

**ENS** — ENSv2 beta on Sepolia: a `UserRegistry` deployed via `VerifiableFactory` and wired in with `setSubregistry`, per-business subnames with native registry expiry, a per-account `PermissionedResolver`, and record-level delegation via `authorizeTextRoles` so an accountant can edit one text key and is reverted on the payout address.

---

## Honest limitations

- `setEligible` is owner-controlled. In production that boundary is a KYC process; pretending otherwise would misrepresent the trust model.
- The oracle for "did the debtor really owe this?" does not exist. `docHash` proves a document was committed to, not that the underlying trade happened.
- Swarm's ACT revocation is **not retroactive** and anyone holding a reference keeps access, so the document is *delivered* to the buyer, never *un-shared*. Factor does not claim revocation.
- Bids are ranked client-side because Arkiv has no `ORDER BY`. Correct for a 50-row page, wrong for a real book.
- `FUSD` is an openly mintable testnet mock with no access control.

## Where this goes next

Replace the eligibility mapping with an attestation-based check so onboarding is not a platform privilege, and emancipate the ENSv2 registry — revoking `ROLE_REGISTRAR` and `ROLE_UNREGISTER` from the deployer — so a business's name provably cannot be taken back by the platform that issued it.

## Licence

MIT.
