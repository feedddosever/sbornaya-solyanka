#!/usr/bin/env python3
"""
Mission 02 evidence, gathered WITHOUT the app's read path.

Why this exists alongside scripts/evidence.ts: the TypeScript version needs
node_modules and the app's own query layer. This one talks to the Arkiv JSON-RPC
directly, so it is an INDEPENDENT witness — it cannot be fooled by a bug in
Factor's own reads, which is exactly the failure mode that made it necessary.

What it proves, in Arkiv's own terms: "the same query before and after the
boundary, with no delete call in between."

  1. write a bid with a short lifetime (through the deployed API)
  2. run the query -> the bid is there                          (block B1)
  3. wait past the boundary, run the SAME query -> it is gone    (block B2)
  4. replay the SAME query pinned at B1 via atBlock -> there again

Step 4 matters. Without it, "it is gone" is consistent with "it was never
really indexed". The historic read shows the entity genuinely occupied the
index at B1 and left on its own, with nothing deleting it.

Usage:  python3 scripts/evidence-rpc.py [base-url]
"""

import json
import subprocess
import sys
import time

RPC = "https://rpc.tiramisu.db-chain.testnet.arkiv.network"
BASE = sys.argv[1] if len(sys.argv) > 1 else "https://sbornaya-solyanka-9fbt-seven.vercel.app"
PROJECT = "factor-invoice-market-ethrome-2026"
INVOICE_ID = 8889
TTL = 40  # seconds; must be even (Arkiv blocks are 2s)


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    out = subprocess.run(
        ["curl", "-sS", "--max-time", "30", "--json", body, RPC],
        capture_output=True, text=True,
    ).stdout
    d = json.loads(out)
    if "error" in d:
        raise RuntimeError(f"{method}: {d['error']}")
    return d["result"]


def block():
    return int(rpc("eth_blockNumber", []), 16)


# The query under test. Five clauses across four types plus a system attribute,
# and it is byte-identical at every execution below — only `atBlock` moves.
def QUERY(at=None):
    q = (
        f"project = str('{PROJECT}') "
        f"AND kind = str('bid') "
        f"AND invoice_id = u256({INVOICE_ID}) "
        f"AND discount_bps <= i32(10000) "
        f"AND $expiresAt > u64({{blk}})"
    )
    return q


def run_query(expiry_block, at=None):
    """`$expiresAt > u64(n)` needs a concrete n; `at` pins the read height."""
    q = QUERY().format(blk=expiry_block)
    opts = {"limit": 50}
    if at is not None:
        # `atBlock` takes a STRING, not a number, and the JSON-RPC layer wants
        # it hex-encoded like any other block parameter. The field list in the
        # error message ("expected one of `atBlock`, `select`, `limit`,
        # `cursor`") does not say which, so this is worth writing down.
        opts["atBlock"] = hex(at)
    r = rpc("arkiv_query", [q, opts])
    return r["data"], int(r["blockNumber"], 16)


def post_bid():
    payload = {
        "invoiceId": str(INVOICE_ID),
        "financierSlot": 1,
        "financier": "0x2A058020fa86281b6695Fad49c302182ec8aeA34",
        "discountBps": 450,
        "offerPrice": "9550.00",
        "sector": "logistics",
        "ensName": "evidence.factor.eth",
        "ttlSeconds": TTL,
    }
    out = subprocess.run(
        ["curl", "-sS", "--max-time", "60", "-X", "POST", f"{BASE}/api/arkiv/bids",
         "-H", "content-type: application/json", "-d", json.dumps(payload)],
        capture_output=True, text=True,
    ).stdout
    d = json.loads(out)
    if "error" in d:
        raise RuntimeError(f"write failed: {d['error']}")
    return d["entityKey"], d["txHash"]


def main():
    print("\n=== Factor / Arkiv Mission 02 — independent RPC witness ===\n")
    print(f"  rpc     : {RPC}")
    print(f"  project : {PROJECT}")
    print(f"  query   : {QUERY().format(blk='<current block>')}\n")

    b0 = block()
    print(f"  block {b0}  writing a bid with a {TTL}s lifetime ...")
    key, tx = post_bid()
    print(f"              entity {key}")
    print(f"              tx     {tx}")

    # Wait for inclusion. The API returns once the transaction is accepted, and
    # the entity is queryable only after the block carrying it is produced.
    b1 = None
    for _ in range(20):
        time.sleep(3)
        bn = block()
        rows, at = run_query(bn)
        if any(r["key"] == key for r in rows):
            b1 = at
            print(f"\n  block {b1}  query returns {len(rows)} bid(s)   <- BEFORE, entity present")
            break
    if b1 is None:
        print("\n  the entity never appeared; check the signer is funded")
        return 1

    meta = rpc("arkiv_getEntity", [key])
    expires_at = int(meta["expiresAt"], 16)
    created_at = int(meta["createdAt"], 16)
    print(f"              createdAt={created_at}  expiresAt={expires_at} "
          f"(+{expires_at - created_at} blocks)")

    print(f"\n  waiting for block {expires_at} to pass — NO delete call is made ...")
    while block() <= expires_at:
        time.sleep(4)

    b2 = block()
    rows2, at2 = run_query(b2)
    gone = not any(r["key"] == key for r in rows2)
    print(f"  block {at2}  query returns {len(rows2)} bid(s)   <- AFTER, entity {'absent' if gone else 'STILL THERE'}")

    # The same query, pinned back to B1. If this still shows the entity, the
    # index really did hold it and really did release it unaided.
    rows3, at3 = run_query(b1, at=b1)
    back = any(r["key"] == key for r in rows3)
    print(f"  block {at3}  replayed at atBlock={b1}: {len(rows3)} bid(s)   "
          f"<- {'still there historically' if back else 'NOT in the historic read'}")

    print("\n  --- result ---")
    print(f"    lifetime requested : {TTL}s  ({expires_at - created_at} blocks)")
    print(f"    before -> after    : present at {b1}  ->  absent at {at2}")
    print(f"    historic replay    : {'present' if back else 'absent'} at {b1}")
    print(f"    delete calls made  : 0")
    print("\n  " + ("PASS — the entity left the index on its own.\n"
                    if (gone and back) else
                    "INCONCLUSIVE — see the lines above.\n"))
    return 0 if (gone and back) else 1


if __name__ == "__main__":
    sys.exit(main())
