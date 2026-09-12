import { NextRequest, NextResponse } from "next/server";
import { discover, publishListing } from "@/arkiv/listings";
import { cleanKey } from "@/arkiv/client";
import type { Sector } from "@/arkiv/schema";
import {
  asAddress,
  asBigInt,
  asBool,
  asDecimalString,
  asNumber,
  asString,
  meta,
} from "@/arkiv/entity";

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
      // Attribute values come back TAGGED, not bare, so every field goes
      // through an unwrapping accessor. Reading them directly yields
      // "[object Object]" in the UI - see src/arkiv/entity.ts.
      listings: page.entities.map((e: any) => {
        const a = e.attributes ?? {};
        return {
          entityKey: e.key,
          invoiceId: asBigInt(a.invoice_id).toString(),
          issuer: asAddress(a.issuer),
          debtor: asAddress(a.debtor),
          sector: asString(a.sector),
          faceValue: asDecimalString(a.face_value),
          dueDate: asNumber(a.due_date),
          ratingBand: asNumber(a.rating_band),
          teaserRef: asString(a.teaser_ref),
          docCommit: asString(a.doc_commit),
          ensName: asString(a.ens_name),
          sold: asBool(a.sold),
          expiresAtBlock: meta(e).expiresAt.toString(),
        };
      }),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/** POST /api/arkiv/listings — publish the queryable shadow of an on-chain claim. */
export async function POST(req: NextRequest) {
  const b = await req.json();
  // One funded Tiramisu key is enough for the whole app.
  const pk = cleanKey(process.env.ARKIV_ISSUER_PK) || cleanKey(process.env.ARKIV_FIN1_PK);
  if (!pk) {
    return NextResponse.json(
      { error: "No Arkiv signing key configured. Set ARKIV_ISSUER_PK or ARKIV_FIN1_PK." },
      { status: 500 },
    );
  }

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
