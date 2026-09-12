/**
 * Reading ENSv2 live. Nothing here is hard-coded: every value comes off Sepolia
 * at call time, which is an explicit ENS bounty requirement ("the demo stands on
 * its own - no hard coded names, addresses or results").
 */
import { createPublicClient, http, parseAbi, keccak256, toHex, namehash } from "viem";
import { sepolia } from "viem/chains";
import { ENSV2, TEXT_KEYS } from "./config";
import { pubkeyFromEnsRecord } from "../swarm/seal";

export const sepoliaClient = createPublicClient({
  chain: sepolia,
  transport: http(process.env.NEXT_PUBLIC_SEPOLIA_RPC ?? undefined),
});

/** labelhash - the STABLE identifier. Use this as a key everywhere.
 *
 *  Do NOT key anything by tokenId: every role grant or revoke regenerates the
 *  ERC-1155 token id (the `TokenRegenerated` event), which silently invalidates
 *  caches and marketplace approvals. This single line is the difference between
 *  a working integration and an hour of confusion. */
export const labelhash = (label: string) => keccak256(toHex(label));
export const labelId = (label: string) => BigInt(labelhash(label));

const registryAbi = parseAbi([
  "function getSubregistry(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  "function getParent() view returns (address, string)",
  "function getState(uint256 anyId) view returns (uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource)",
  "function getOwner(uint256 anyId) view returns (address)",
]);

const resolverAbi = parseAbi([
  "function addr(bytes32 node) view returns (address)",
  "function text(bytes32 node, string key) view returns (string)",
  "function pubkey(bytes32 node) view returns (bytes32 x, bytes32 y)",
]);

export enum NameStatus {
  Available = 0,
  Reserved = 1,
  Registered = 2,
}

/** The RootRegistry address is not published. Derive it. */
export async function rootRegistry(): Promise<`0x${string}`> {
  const [root] = await sepoliaClient.readContract({
    address: ENSV2.ethRegistry as `0x${string}`,
    abi: registryAbi,
    functionName: "getParent",
  });
  return root;
}

/** Live registry state for a label in a given registry. */
export async function nameState(registry: `0x${string}`, label: string) {
  const [status, expiry, latestOwner, tokenId, resource] =
    await sepoliaClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getState",
      args: [labelId(label)],
    });

  return {
    status: status as NameStatus,
    statusLabel: NameStatus[status as NameStatus],
    expiry,
    expiresAt: new Date(Number(expiry) * 1000),
    latestOwner,
    tokenId, // <- read, display, but never persist as a key
    resource,
    isExpired: Number(expiry) !== 0 && Number(expiry) * 1000 < Date.now(),
  };
}

/** Confirm a business subregistry is actually wired into the hierarchy.
 *  Subnames registered before `setSubregistry` is called have tokens but never
 *  resolve, which is the single most common ENSv2 false start. */
export async function subregistryOf(label: string): Promise<`0x${string}`> {
  return sepoliaClient.readContract({
    address: ENSV2.ethRegistry as `0x${string}`,
    abi: registryAbi,
    functionName: "getSubregistry",
    args: [label],
  });
}

export interface BusinessProfile {
  name: string;
  payoutAddress: `0x${string}` | null;
  sector: string | null;
  contact: string | null;
  /** Uncompressed secp256k1 key used to seal the document handover. */
  sealingPublicKey: `0x${string}` | null;
}

/**
 * Everything Factor needs about a counterparty, read from their ENSv2 records.
 *
 * The `pubkey` record is what makes the encrypted handover work: the issuer
 * seals the Swarm reference to this key, so the name is not just a label - it
 * carries the material needed to transact privately with its owner.
 */
export async function businessProfile(
  fullName: string,
  resolver: `0x${string}`,
): Promise<BusinessProfile> {
  const node = namehash(fullName);

  const [payout, sector, contact, pk] = await Promise.all([
    sepoliaClient
      .readContract({ address: resolver, abi: resolverAbi, functionName: "addr", args: [node] })
      .catch(() => null),
    sepoliaClient
      .readContract({
        address: resolver,
        abi: resolverAbi,
        functionName: "text",
        args: [node, TEXT_KEYS.sector],
      })
      .catch(() => null),
    sepoliaClient
      .readContract({
        address: resolver,
        abi: resolverAbi,
        functionName: "text",
        args: [node, TEXT_KEYS.contact],
      })
      .catch(() => null),
    sepoliaClient
      .readContract({ address: resolver, abi: resolverAbi, functionName: "pubkey", args: [node] })
      .catch(() => null),
  ]);

  let sealingPublicKey: `0x${string}` | null = null;
  if (pk && Array.isArray(pk)) {
    const [x, y] = pk as [`0x${string}`, `0x${string}`];
    const empty = /^0x0*$/;
    if (!empty.test(x) && !empty.test(y)) sealingPublicKey = pubkeyFromEnsRecord(x, y);
  }

  return {
    name: fullName,
    payoutAddress: (payout as `0x${string}`) ?? null,
    sector: (sector as string) || null,
    contact: (contact as string) || null,
    sealingPublicKey,
  };
}

/**
 * Read the live role bitmap for an account on a resource and describe what it
 * can actually do. Powers the "what can the platform still do to my name?"
 * panel, which is the honest way to present an emancipated registry.
 */
export function describeRoles(bitmap: bigint): string[] {
  const out: string[] = [];
  const check = (role: bigint, label: string) => {
    if ((bitmap & role) !== 0n) out.push(label);
  };
  check(1n << 0n, "register new subnames");
  check(1n << 12n, "unregister names");
  check(1n << 16n, "renew names");
  check(1n << 20n, "repoint subregistries");
  check(1n << 24n, "change resolvers");
  check((1n << 28n) << 128n, "transfer names");
  return out;
}
