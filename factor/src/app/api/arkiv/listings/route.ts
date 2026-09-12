import { NextRequest, NextResponse } from "next/server";
import { discover, publishListing } from "@/arkiv/listings";
import type { Sector } from "@/arkiv/schema";

/**
 * GET /api/arkiv/listings?sector=logistics&minFaceValue=5000&dueBefore=...&maxRatingBand=3
 *
 * Every parameter here maps to one clause of the compound query, so the filter
 * form in the UI *is* the query builder.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  try {
    const page = await discover({
      sector: (p.get("sector") as Sector) ?? undefined,
      minFaceValue: p.get("minFaceValue") ?? undefined,
      maxFaceValue: p.get("maxFaceValue") ?? undefined,
      dueBefore: p.get("dueBefore") ? BigInt(p.get("dueBefore")!) : undefined,
      maxRatingBand: p.get("maxRatingBand") ? Number(p.get("maxRatingBand")) : undefined,
    });

    return NextResponse.json({
      blockNumber: page.blockNumber?.toString(),
      listings: page.entities.map((e: any) => ({
        entityKey: e.key,
        invoiceId: String(e.attributes.invoiceId),
        issuer: e.attributes.issuer,
        debtor: e.attributes.debtor,
        sector: e.attributes.sector,
        faceValue: String(e.attributes.faceValue),
        dueDate: Number(e.attributes.dueDate),
        ratingBand: Number(e.attributes.ratingBand),
        teaserRef: e.attributes.teaserRef,
        docCommit: e.attributes.docCommit,
        ensName: e.attributes.ensName,
        sold: Boolean(e.attributes.sold),
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/** POST /api/arkiv/listings — publish the queryable shadow of an on-chain claim. */
export async function POST(req: NextRequest) {
  const b = await req.json();
  const pk = process.env.ARKIV_ISSUER_PK as `0x${string}`;
  if (!pk) return NextResponse.json({ error: "ARKIV_ISSUER_PK not set" }, { status: 500 });

  try {
    const { entityKey, txHash } = await publishListing(pk, {
      invoiceId: BigInt(b.invoiceId),
      issuer: b.issuer,
      debtor: b.debtor,
      sector: b.sector,
      faceValue: String(b.faceValue),
      dueDate: BigInt(b.dueDate),
      ratingBand: Number(b.ratingBand ?? 3),
      teaserRef: String(b.teaserRef ?? ""),
      docCommit: b.docCommit,
      claimContract: b.claimContract,
      ensName: String(b.ensName ?? ""),
      sold: false,
    });
    return NextResponse.json({ entityKey, txHash });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
