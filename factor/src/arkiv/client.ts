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

export const arkivPublic = createPublicClient({
  chain: tiramisu,
  transport: http(),
});

export function arkivWallet(privateKey: `0x${string}`) {
  return createWalletClient({
    chain: tiramisu,
    transport: http(),
    account: privateKeyToAccount(privateKey),
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
