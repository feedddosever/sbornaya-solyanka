/**
 * Arkiv clients for the Tiramisu testnet.
 *
 * Reads need no funds and no API key. Writes need GLM on the signing account
 * (faucet: hub.arkiv.network).
 *
 * Factor uses TWO write signers on purpose, because an Arkiv entity is owned by
 * the wallet that signed it: the issuer signs listings and handovers, each
 * financier signs their own bids. That makes `$owner` a meaningful filter
 * instead of a constant.
 */
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const ARKIV_CHAIN_ID = 7738577;
export const ARKIV_RPC = "https://rpc.tiramisu.db-chain.testnet.arkiv.network";
export const ARKIV_WS = "wss://rpc.tiramisu.db-chain.testnet.arkiv.network";

/** Nominal block time. The docs are explicit that block production is not a
 *  clock, so duration-based expiries drift. Never present a `fromMinutes(1)`
 *  lifetime to a user as "one minute" - read `$expiresAt` back instead. */
export const ARKIV_BLOCK_TIME_SECONDS = 2;

/**
 * Optional access key. The public RPC works without one at a default rate
 * limit, and a key only raises that limit — but a deployed app whose clients
 * poll the bid book every few seconds will hit the default ceiling quickly, so
 * set one before demoing anything public.
 *
 * Get it from hub.arkiv.network/api-keys (one key per wallet per network;
 * choose Tiramisu). The RPC accepts it in the URL path, as `X-API-KEY`, or as
 * a bearer token; the path form is used here because it needs no custom
 * transport config.
 */
const ARKIV_KEY = process.env.ARKIV_API_KEY ?? process.env.NEXT_PUBLIC_ARKIV_API_KEY;
const rpcUrl = ARKIV_KEY ? `${ARKIV_RPC}/${ARKIV_KEY}` : undefined;

export const arkivPublic = createPublicClient({
  chain: tiramisu,
  transport: http(rpcUrl),
});

/**
 * Read a signing key from the environment, tolerating the single most common
 * paste error: a trailing newline. Copying a key out of a terminal or a hub UI
 * very often brings one along, and viem rejects it with an opaque message.
 */
export function cleanKey(raw: string | undefined): `0x${string}` | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  return t ? (t as `0x${string}`) : undefined;
}

export function arkivWallet(privateKey: `0x${string}`) {
  return createWalletClient({
    chain: tiramisu,
    transport: http(rpcUrl),
    account: privateKeyToAccount((privateKey as string).trim() as `0x${string}`),
  });
}

/** Current Tiramisu block height, needed for every `$expiresAt` comparison. */
export async function currentBlock(): Promise<bigint> {
  return arkivPublic.getBlockNumber();
}

/** Approximate seconds until an entity expires, from its `$expiresAt` block. */
export function secondsUntil(expiresAtBlock: bigint, nowBlock: bigint): number {
  const delta = Number(expiresAtBlock - nowBlock);
  return delta <= 0 ? 0 : delta * ARKIV_BLOCK_TIME_SECONDS;
}
