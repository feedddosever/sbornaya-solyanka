/**
 * Swarm via Swarm ID.
 *
 * Swarm ID is a hidden-iframe identity + upload proxy: the user signs in with a
 * passkey (or an Ethereum account) and the iframe signs postage stamps in the
 * browser. There is no Bee node to run and nothing to install, which is why
 * Factor can put real documents on Swarm inside a hackathon.
 *
 * ── WHY THE IMPORT IS LAZY ────────────────────────────────────────────────
 *
 * `@snaha/swarm-id` CANNOT be imported on the server. It bundles axios, whose
 * FormData shim runs during module initialisation:
 *
 *     "object" == typeof self ? self.FormData : window.FormData
 *
 * Under Node there is no `self`, so it falls through to `window.FormData` and
 * throws `ReferenceError: window is not defined`. This happens at REQUIRE
 * time, before any component renders, which means a plain top-level
 * `import { SwarmIdClient } from "@snaha/swarm-id"` breaks `next build` during
 * the prerender pass of any page that touches this file — even a
 * `"use client"` page, because Next still renders client components on the
 * server to produce the initial HTML.
 *
 * Verified by importing the published bundle in bare Node: it reproduces the
 * exact ReferenceError and call chain seen in the Vercel log.
 *
 * The fix: `import type` (erased at compile time, zero runtime cost) plus a
 * dynamic `await import()` inside `initSwarm`, which only ever runs in a
 * browser. Do NOT convert these back to a static import.
 *
 * ── OTHER NOTES ──────────────────────────────────────────────────────────
 *
 * An earlier version of this file claimed feeds and ACT require a running Bee
 * node and are unavailable to a dApp. That is FALSE. Verified against the
 * v0.4.0 source, `SwarmIdClient` also exposes makeSequentialFeedReader/Writer,
 * makeEpochFeedReader/Writer, makeSOCReader/Writer, createFeedManifest,
 * gsocMine/gsocSend, uploadChunk/downloadChunk, actUploadData/actDownloadData/
 * actAddGrantees and deriveAppSecret — all without a node.
 *
 * Factor still keeps its index in Arkiv, but for the honest reason: a feed
 * gives you a mutable POINTER, while the market needs a mutable, QUERYABLE
 * set, which no number of feeds answers.
 *
 * The one limit that does still bind: `{ encrypt: true }` embeds the
 * decryption key inside the 128-character reference. The reference IS the
 * capability, so it must never be written to a public index — see ./seal.ts.
 */

// Type-only: erased by the compiler, so nothing is required at runtime.
import type { SwarmIdClient, ConnectionInfo } from "@snaha/swarm-id";

export type UploadMode = "user-stamp" | "subsidised" | "unavailable";

export interface SwarmIdentity {
  id: string;
  name: string;
  address: `0x${string}`;
  publicKey?: string;
  sharingPublicKey?: string;
}

let client: SwarmIdClient | null = null;
let initialising: Promise<SwarmIdClient> | null = null;

function assertBrowser(fn: string): void {
  if (typeof window === "undefined") {
    throw new Error(
      `${fn} is browser-only: @snaha/swarm-id bundles axios, which touches ` +
        `window.FormData while initialising. Call it from an effect or an ` +
        `event handler, never during render or on the server.`,
    );
  }
}

/**
 * Create and initialise the Swarm ID client. Must run before anything else —
 * it creates the hidden iframe that holds all key material.
 *
 * Safe to call more than once: concurrent callers share one in-flight promise.
 */
export async function initSwarm(
  onChange?: (info: ConnectionInfo) => void,
): Promise<SwarmIdClient> {
  assertBrowser("initSwarm");
  if (client) return client;
  if (initialising) return initialising;

  initialising = (async () => {
    // The dynamic import is the whole point — see the header comment.
    const { SwarmIdClient: Ctor } = await import("@snaha/swarm-id");

    /**
     * OMIT `subsidisedGatewayUrl` UNLESS IT IS A REAL URL.
     *
     * Swarm ID validates its options with zod and the field is typed as a
     * URL, so passing an empty string — which is exactly what
     * `process.env.NEXT_PUBLIC_*` yields when the variable exists but is
     * blank — fails validation and takes down the whole `initialize()` call:
     *
     *   Swarm ID init failed: Invalid message format:
     *     path: ["subsidisedGatewayUrl"], format: "url"
     *
     * That is a total failure of the Swarm layer caused by an unset optional
     * setting, and it bit this deployment. Copying `.env.example` into a host
     * creates the variable as an empty string, which is the common case. So
     * the key is only added when there is something valid to put in it.
     */
    const gateway = process.env.NEXT_PUBLIC_SWARM_SUBSIDISED_GATEWAY?.trim();
    const options: Record<string, unknown> = {
      iframeOrigin: "https://swarm-id.snaha.net",
      metadata: {
        name: "Factor",
        description: "Invoice financing where the document stays yours",
      },
      onConnectionChange: (info: ConnectionInfo) => onChange?.(info),
    };
    if (gateway && /^https?:\/\/\S+$/i.test(gateway)) {
      options.subsidisedGatewayUrl = gateway;
    }

    const c = new Ctor(options as never);

    await c.initialize();
    client = c;
    return c;
  })();

  try {
    return await initialising;
  } catch (e) {
    initialising = null; // let a later attempt retry
    throw e;
  }
}

/** The initialised client, or a clear error explaining what was skipped. */
function required(fn: string): SwarmIdClient {
  assertBrowser(fn);
  if (!client) {
    throw new Error(`${fn} called before initSwarm() finished. Await initSwarm() first.`);
  }
  return client;
}

/** Opens the passkey / SIWE popup. */
export async function connectSwarm(): Promise<ConnectionInfo> {
  const c = client ?? (await initSwarm());
  await c.connect();
  return c.connectionInfo;
}

export function connectionInfo(): ConnectionInfo | null {
  return client ? client.connectionInfo : null;
}

/**
 * Guard against the most common Swarm ID surprise: a user can be signed in and
 * still have `canUpload === false`, because they have no postage batch and the
 * app set no subsidised gateway. Surface that as a real message rather than a
 * silent failure.
 *
 * Pure and synchronous, so it is safe to call during render.
 */
export function uploadBlockedReason(info: ConnectionInfo | null | undefined): string | null {
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
  const c = required("uploadTeaser");
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
  const c = required("uploadInvoiceDocument");
  return c.uploadFile(file, file.name, { encrypt: true, deferred: false });
}

export async function downloadDocument(reference: string) {
  return required("downloadDocument").downloadFile(reference);
}

export async function downloadJson<T = unknown>(reference: string): Promise<T> {
  const data = await required("downloadJson").downloadData(reference);
  return JSON.parse(new TextDecoder().decode(data)) as T;
}
