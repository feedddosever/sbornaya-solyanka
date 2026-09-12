/**
 * Swarm via Swarm ID.
 *
 * Swarm ID is a hidden-iframe identity + upload proxy: the user signs in with a
 * passkey (or an Ethereum account) and the iframe signs postage stamps in the
 * browser. There is no Bee node to run and nothing to install, which is why
 * Factor can put real documents on Swarm inside a hackathon.
 *
 * CORRECTION worth recording, because the docs led us wrong: an earlier pass of
 * this file claimed feeds and ACT require a running Bee node and are unavailable
 * to a dApp. That is FALSE. Verified against the v0.4.0 source
 * (github.com/snaha/swarm-id, lib/src/swarm-id-client.ts), `SwarmIdClient`
 * exposes all of:
 *
 *   makeSequentialFeedReader/Writer   makeEpochFeedReader/Writer
 *   makeSOCReader/Writer              createFeedManifest
 *   gsocMine / gsocSend               uploadChunk / downloadChunk
 *   actUploadData / actDownloadData / actAddGrantees
 *   deriveAppSecret                   getPostageBatch / isBeeConnected
 *
 * So Swarm can hold mutable state in the browser after all. Factor still keeps
 * its index in Arkiv, but for the honest reason rather than the wrong one: a
 * feed gives you a mutable POINTER, while the market needs a mutable,
 * QUERYABLE set - "unsold logistics invoices over 5,000 maturing inside 90
 * days" is a compound filter over typed attributes, which no feed answers.
 *
 * The one limit that does still bind:
 *   `{ encrypt: true }` embeds the decryption key inside the 128-character
 *   reference. The reference IS the capability, so it must never be written to
 *   a public index - see ./seal.ts.
 */
import { SwarmIdClient } from "@snaha/swarm-id";

export type UploadMode = "user-stamp" | "subsidised" | "unavailable";

export interface SwarmIdentity {
  id: string;
  name: string;
  address: `0x${string}`;
  publicKey?: string;
  sharingPublicKey?: string;
}

let client: SwarmIdClient | null = null;

export function getSwarmClient(onChange?: (info: any) => void): SwarmIdClient {
  if (client) return client;

  client = new SwarmIdClient({
    iframeOrigin: "https://swarm-id.snaha.net",
    metadata: {
      name: "Factor",
      description: "Invoice financing where the document stays yours",
    },
    // If the gift code does not give end users their own postage batch, set a
    // subsidised gateway so the app pays and `canUpload` is never false:
    // subsidisedGatewayUrl: process.env.NEXT_PUBLIC_SWARM_SUBSIDISED_GATEWAY,
    onConnectionChange: (info: any) => onChange?.(info),
  });

  return client;
}

/** Must run before anything else - it creates the hidden iframe. */
export async function initSwarm(onChange?: (info: any) => void) {
  const c = getSwarmClient(onChange);
  await c.initialize();
  return c;
}

/** Opens the passkey / SIWE popup. */
export async function connectSwarm() {
  const c = getSwarmClient();
  await c.connect();
  return c.connectionInfo;
}

/**
 * Guard against the most common Swarm ID surprise: a user can be signed in and
 * still have `canUpload === false`, because they have no postage batch and the
 * app set no subsidised gateway. Surface that as a real message rather than a
 * silent failure.
 */
export function uploadBlockedReason(info: any): string | null {
  if (!info) return "Swarm ID not initialised yet.";
  if (!info.identity) return "Not signed in to Swarm ID.";
  if (info.canUpload) return null;

  const mode = info.uploadMode as UploadMode;
  if (mode === "unavailable" && info.uploadUnavailableReason === "no-stamp") {
    return "No postage batch on this Swarm account. Redeem a gift code at the Swarm desk, or configure a subsidised gateway.";
  }
  if (info.uploadUnavailableReason === "stamper-failed") {
    return "Swarm ID could not sign a postage stamp. Try reconnecting.";
  }
  return `Uploads unavailable (mode: ${mode}).`;
}

/**
 * The PUBLIC redacted teaser. Unencrypted on purpose: its reference goes
 * straight into the Arkiv listing so anyone can read it, and it carries no
 * counterparty names, no line items and no exact amounts.
 */
export async function uploadTeaser(summary: object): Promise<{ reference: string }> {
  const c = getSwarmClient();
  const bytes = new TextEncoder().encode(JSON.stringify(summary, null, 2));
  // deferred: false - the default returns a reference BEFORE the data is
  // network-available, which makes a fresh document 404 mid-demo.
  return c.uploadData(bytes, { encrypt: false, deferred: false });
}

/**
 * The full invoice, encrypted. The returned reference is 128 hex characters and
 * contains the decryption key, so the caller must treat it as a secret: commit
 * to it on-chain, seal it to the buyer, but never publish it.
 */
export async function uploadInvoiceDocument(file: File): Promise<{ reference: string }> {
  const c = getSwarmClient();
  return c.uploadFile(file, file.name);
}

export async function downloadDocument(reference: string) {
  const c = getSwarmClient();
  return c.downloadFile(reference);
}

export async function downloadJson<T = unknown>(reference: string): Promise<T> {
  const c = getSwarmClient();
  const data = await c.downloadData(reference);
  return JSON.parse(new TextDecoder().decode(data)) as T;
}
