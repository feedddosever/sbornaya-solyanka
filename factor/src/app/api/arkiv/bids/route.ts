/**
 * Arkiv bid endpoints.
 *
 * Writes happen server-side because an Arkiv entity is owned by the wallet that
 * signs it, and those signing keys must not reach the browser. This also keeps
 * the browser wallet pinned to Fuji, so nobody is asked to switch networks
 * during a demo.
 */
import { NextRequest, NextResponse } from "next/server";
import { postBid, liveBidsFor } from "@/arkiv/bids";
import type { Sector } from "@/arkiv/schema";

/** GET /api/arkiv/bids?invoiceId=1&maxDiscountBps=800 */
export async function GET(req: NextRequest) {
  const invoiceId = req.nextUrl.searchParams.get("invoiceId");
  const maxBps = Number(req.nextUrl.searchParams.get("maxDiscountBps") ?? 10_000);
  if (!invoiceId) {
    return NextResponse.json({ error: "invoiceId required" }, { status: 400 });
  }

  try {
    const bids = await liveBidsFor(BigInt(invoiceId), maxBps);
    return NextResponse.json({
      bids: bids.map((b) => ({
        ...b,
        invoiceId: b.invoiceId.toString(),
        expiresAtBlock: b.expiresAtBlock.toString(),
      })),
      queriedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/** POST /api/arkiv/bids  { invoiceId, financierSlot: 1|2, discountBps, offerPrice, sector, ensName } */
export async function POST(req: NextRequest) {
  const body = await req.json();

  // Two financier keys, so bids have different `$owner` values and
  // `ownedBy()` filtering is meaningful rather than constant.
  const pk =
    body.financierSlot === 2
      ? (process.env.ARKIV_FIN2_PK as `0x${string}`)
      : (process.env.ARKIV_FIN1_PK as `0x${string}`);

  if (!pk) {
    return NextResponse.json(
      { error: "ARKIV_FIN1_PK / ARKIV_FIN2_PK not configured" },
      { status: 500 },
    );
  }

  // Keep demo lifetimes short and even. Short because nobody can wait on
  // Sunday morning; even because the SDK requires a multiple of the 2s block.
  const requested = Number(body.ttlSeconds ?? 60);
  const ttlSeconds = Math.max(2, requested - (requested % 2));

  try {
    const { entityKey, txHash } = await postBid(pk, {
      invoiceId: BigInt(body.invoiceId),
      financier: body.financier,
      discountBps: Number(body.discountBps),
      offerPrice: String(body.offerPrice),
      sector: body.sector as Sector,
      ensName: String(body.ensName ?? ""),
      ttlSeconds,
    });

    return NextResponse.json({ entityKey, txHash, ttlSeconds });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
