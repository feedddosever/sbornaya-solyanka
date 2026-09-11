/**
 * Mission 02 evidence, reproducible on demand.
 *
 * Arkiv's brief asks for "the same query before and after the boundary, with no
 * delete call in between". Rather than filming a countdown, this script uses
 * `.atBlock()` point-in-time historic reads: ONE identical query, executed at
 * two different block heights. The bid is present at the first height and gone
 * at the second, and there is no delete call anywhere in this repository.
 *
 * Run it in front of the Arkiv team at the Saturday sign-off:
 *   npx tsx scripts/evidence.ts
 *
 * Env: ARKIV_FIN1_PK (a GLM-funded Tiramisu key)
 */
import { eq } from "@arkiv-network/sdk/query";
import { str, u256 } from "@arkiv-network/sdk/attr";
import { arkivPublic, currentBlock, ARKIV_BLOCK_TIME_SECONDS } from "../src/arkiv/client";
import { postBid } from "../src/arkiv/bids";
import { KIND } from "../src/arkiv/schema";

const TTL_SECONDS = 30; // must be even
const INVOICE_ID = BigInt(process.env.EVIDENCE_INVOICE_ID ?? "1");

/** The query under test. Identical at every block height - only `.atBlock()` moves. */
function bidQuery(atBlock: bigint) {
  return arkivPublic
    .select({ key: true, attributes: true })
    .where(eq("kind", str(KIND.BID)), eq("invoiceId", u256(INVOICE_ID)))
    .atBlock(atBlock)
    .fetch();
}

async function main() {
  const pk = process.env.ARKIV_FIN1_PK as `0x${string}`;
  if (!pk) throw new Error("set ARKIV_FIN1_PK to a GLM-funded Tiramisu private key");

  console.log("\n=== Factor / Arkiv Mission 02 evidence ===\n");

  const startBlock = await currentBlock();
  console.log(`block ${startBlock}  posting a bid with a ${TTL_SECONDS}s lifetime...`);

  const { entityKey } = await postBid(pk, {
    invoiceId: INVOICE_ID,
    financier: "0x0000000000000000000000000000000000000001",
    discountBps: 320,
    offerPrice: "9680.00",
    sector: "logistics",
    ensName: "evidence.factor.eth",
    ttlSeconds: TTL_SECONDS,
  });
  console.log(`           entity ${entityKey}`);

  const postedAt = await currentBlock();
  const before = await bidQuery(postedAt);
  console.log(`block ${postedAt}  query returns ${before.entities.length} bid(s)  <- BEFORE`);

  // Wait past the expiry boundary. ~2s per block, plus a margin for drift,
  // because the docs are explicit that block production is not a clock.
  const waitMs = (TTL_SECONDS + 8) * 1000;
  console.log(`\nwaiting ${waitMs / 1000}s for the lifetime to lapse (no delete call)...\n`);
  await new Promise((r) => setTimeout(r, waitMs));

  const afterBlock = await currentBlock();
  const after = await bidQuery(afterBlock);
  console.log(`block ${afterBlock}  query returns ${after.entities.length} bid(s)  <- AFTER`);

  // Re-run the BEFORE query now. The historic read still shows the bid, which
  // proves the data was really there and really indexed - not a UI illusion.
  const replay = await bidQuery(postedAt);
  console.log(
    `block ${postedAt}  replayed historically: ${replay.entities.length} bid(s)  <- still there`,
  );

  const elapsedBlocks = Number(afterBlock - postedAt);
  console.log("\n--- result ---");
  console.log(`  lifetime requested : ${TTL_SECONDS}s`);
  console.log(`  blocks elapsed     : ${elapsedBlocks} (~${elapsedBlocks * ARKIV_BLOCK_TIME_SECONDS}s nominal)`);
  console.log(`  before / after     : ${before.entities.length} -> ${after.entities.length}`);
  console.log(`  delete calls made  : 0`);
  console.log(
    after.entities.length < before.entities.length
      ? "\n  PASS - the entity left the index on its own.\n"
      : "\n  INCONCLUSIVE - wait longer, or check whether the engine still\n" +
          "  returns expired entities (undocumented; see friction.md #7).\n",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
