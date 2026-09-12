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
import { PROJECT } from "../src/arkiv/project";

const TTL_SECONDS = 30; // must be even
const INVOICE_ID = BigInt(process.env.EVIDENCE_INVOICE_ID ?? "1");

/**
 * The query under test. Identical at every block height - only `.atBlock()` moves.
 *
 * The `project` clause is load-bearing HERE IN PARTICULAR, not just good
 * hygiene: this script proves a claim about a COUNT going down. Forty teams
 * share this testnet, so without it another team's bid carrying the same
 * `invoice_id` lands in the same result set, and the before/after numbers stop
 * being about Factor's entity at all. An evidence script that can be polluted
 * by a stranger is not evidence.
 *
 * Attribute names are snake_case because the node rejects uppercase after the
 * first character even though the SDK's validator accepts it. `invoiceId` here
 * would not error - it would just match nothing, quietly reporting 0 -> 0 and
 * an INCONCLUSIVE result for a mechanism that actually works.
 */
function bidQuery(atBlock: bigint) {
  return arkivPublic
    .select({ key: true, attributes: true })
    .where(
      eq(PROJECT.key, str(PROJECT.value)),
      eq("kind", str(KIND.BID)),
      eq("invoice_id", u256(INVOICE_ID)),
    )
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
          "  returns expired entities. Block production is not a clock, so a\n" +
          "  requested lifetime in seconds can lapse later than the wall clock\n" +
          "  suggests; see the duration-helpers item in friction.md.\n",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
