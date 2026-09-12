/**
 * Listings: the discovery index over invoices issued on Fuji.
 *
 * A listing is the queryable shadow of an on-chain claim. The claim is the
 * asset; the listing is how anyone finds it. Arkiv's own guidance is to leave
 * the bytes where they are and put a queryable record beside them - here the
 * bytes are on Swarm, the asset is on Avalanche, and this is the index.
 */
import { bool, dec, i32, str, u256, u64, addr } from "@arkiv-network/sdk/attr";
import { eq, gte, lte } from "@arkiv-network/sdk/query";
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk/utils";
import { arkivPublic, arkivWallet } from "./client";
import { listingAttributes, KIND, type ListingInput, type Sector } from "./schema";
import { PROJECT } from "./project";

/** Publish a listing. Lifetime runs to maturity plus a grace window, so the
 *  index self-prunes: an invoice nobody financed stops cluttering the market. */
export async function publishListing(privateKey: `0x${string}`, l: ListingInput) {
  const secondsToDue = Number(l.dueDate - BigInt(Math.floor(Date.now() / 1000)));
  const lifetime = Math.max(120, secondsToDue + 7 * 24 * 3600);

  return arkivWallet(privateKey).createEntity({
    payload: jsonToPayload({
      description: `Invoice ${l.invoiceId} issued by ${l.ensName}`,
      // The teaser is public and unencrypted; the full document is not here.
      teaserRef: l.teaserRef,
    }),
    contentType: "application/json",
    attributes: listingAttributes(l),
    // round to an even number of seconds - the SDK requires a multiple of 2
    expires: ExpirationTime.fromSeconds(lifetime - (lifetime % 2)),
  });
}

export interface DiscoveryFilter {
  sector?: Sector;
  minFaceValue?: string; // decimal string
  maxFaceValue?: string;
  dueBefore?: bigint; // unix seconds
  maxRatingBand?: number; // 1..5
}

/**
 * THE FIVE-CLAUSE DISCOVERY QUERY (financier side).
 *
 * A financier's real question is never "show me invoice 7". It is "unsold
 * logistics invoices over 5,000, maturing inside my horizon, rated 3 or
 * better" - four predicates plus the kind partition, across str / dec / u64 /
 * i32 / bool. Assembling it from a form is the honest version of a query
 * builder, and every clause below maps to a control in the UI.
 */
export async function discover(f: DiscoveryFilter) {
  const clauses: any[] = [
    // Best practice #1. Without this the market fills with other teams'
    // entities - forty builders share this testnet.
    eq(PROJECT.key, str(PROJECT.value)),
    eq("kind", str(KIND.LISTING)),
    eq("sold", bool(false)),
  ];

  if (f.sector) clauses.push(eq("sector", str(f.sector)));
  if (f.minFaceValue) clauses.push(gte("face_value", dec(f.minFaceValue)));
  if (f.maxFaceValue) clauses.push(lte("face_value", dec(f.maxFaceValue)));
  if (f.dueBefore) clauses.push(lte("due_date", u64(f.dueBefore)));
  if (f.maxRatingBand) clauses.push(lte("rating_band", i32(f.maxRatingBand)));

  // Arkiv throws InvalidPredicateError on a filter-less query, so the two
  // base clauses above are load-bearing, not decoration.
  const page = await arkivPublic
    .select({ key: true, attributes: true, payload: true })
    .where(...clauses)
    .limit(100)
    .fetch();

  return page;
}

/** One listing by on-chain token id. */
export async function listingFor(invoiceId: bigint) {
  const page = await arkivPublic
    .select({ key: true, attributes: true, payload: true })
    .where(eq(PROJECT.key, str(PROJECT.value)),
    eq("kind", str(KIND.LISTING)), eq("invoice_id", u256(invoiceId)))
    .limit(1)
    .fetch();
  return page.entities[0] ?? null;
}

/** Everything this issuer has ever listed. */
export async function listingsByIssuer(issuer: `0x${string}`) {
  const page = await arkivPublic
    .select({ key: true, attributes: true })
    .where(eq(PROJECT.key, str(PROJECT.value)),
    eq("kind", str(KIND.LISTING)), eq("issuer", addr(issuer)))
    .limit(100)
    .fetch();
  return page.entities;
}

/** Walk every page. `for await` handles cursoring; MAX_LIMIT is 200 per page. */
export async function allOpenListings() {
  const out: any[] = [];
  for await (const entity of arkivPublic
    .select({ key: true, attributes: true })
    .where(eq(PROJECT.key, str(PROJECT.value)),
    eq("kind", str(KIND.LISTING)), eq("sold", bool(false)))) {
    out.push(entity);
  }
  return out;
}
