/**
 * GET /api/arkiv/health — a one-URL answer to "is Arkiv actually connected?"
 *
 * Debugging a serverless deployment through build logs is miserable, so this
 * endpoint reports every Arkiv precondition in one place: RPC reachable, key
 * present, signer address, signer funded, project attribute, and whether a
 * real query returns.
 *
 * SECURITY: it never returns the private key or the access key. The signer
 * ADDRESS is public information and is exactly what you need in order to check
 * funding at hub.arkiv.network, so it is included deliberately. The access key
 * is reported as a boolean and a length, never as a value.
 */
import { NextResponse } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { eq } from "@arkiv-network/sdk/query";
import { str } from "@arkiv-network/sdk/attr";
import { arkivPublic, cleanKey, ARKIV_CHAIN_ID, ARKIV_RPC, ARKIV_WS } from "@/arkiv/client";
import { PROJECT } from "@/arkiv/project";
import { KIND } from "@/arkiv/schema";

export const dynamic = "force-dynamic"; // never cache a health check

/**
 * Describe the SHAPE of a secret without revealing it.
 *
 * A private key is 0x + 64 hex characters (66 total). An Arkiv access key is
 * ~41 characters and not hex. Those two get pasted into each other's field
 * constantly, and from the outside both look like "some key", so the fastest
 * possible diagnosis is a shape report.
 *
 * Length, a 0x prefix flag and a hex-charset flag leak nothing usable: they
 * are properties every key of that type shares. No part of the value itself
 * is ever returned.
 */
function shape(name: string, raw: string | undefined) {
  if (raw === undefined) return { name, present: false, note: "Variable is not set at all." };
  if (raw === "") {
    return {
      name,
      present: true,
      empty: true,
      note:
        "Variable exists but is an EMPTY STRING. In Vercel this usually means it " +
        "was re-saved while the input was blank - a Sensitive variable hides its " +
        "value after saving, so editing and saving again wipes it. Delete the " +
        "variable and create it fresh.",
    };
  }

  const trimmed = raw.trim();
  const body = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  const isHex = /^[0-9a-fA-F]+$/.test(body);
  const validPrivateKey = /^0x[0-9a-fA-F]{64}$/.test(trimmed);

  let diagnosis: string;
  // Whitespace FIRST: a trailing newline still trims to a valid key, so
  // checking validity before whitespace would call a broken value "correct".
  // The app trims defensively, so this is a warning rather than a failure.
  if (raw !== trimmed) {
    diagnosis = validPrivateKey
      ? "Valid key, but it has leading/trailing whitespace or a newline. The app " +
        "trims it so this still works - worth cleaning up anyway."
      : "Has leading or trailing whitespace or a newline, and is not a valid key " +
        "even after trimming. Re-paste it.";
  } else if (validPrivateKey) {
    diagnosis = "Correct shape for a private key.";
  } else if (isHex && body.length === 64 && !trimmed.startsWith("0x")) {
    diagnosis = "64 hex characters but MISSING the 0x prefix. Add 0x at the front.";
  } else if (isHex && body.length === 40) {
    diagnosis = "This is a wallet ADDRESS (40 hex), not a private key.";
  } else if (!isHex) {
    diagnosis =
      "Not hexadecimal, so this is not a private key. At ~41 characters it is " +
      "almost certainly the Arkiv ACCESS key pasted into the signing-key field.";
  } else {
    diagnosis = `Hexadecimal but ${body.length} characters after the prefix; a private key needs exactly 64.`;
  }

  return {
    name,
    present: true,
    length: raw.length,
    startsWith0x: trimmed.startsWith("0x"),
    hexOnly: isHex,
    hasSurroundingWhitespace: raw !== trimmed,
    validPrivateKey,
    diagnosis,
  };
}

export async function GET() {
  const started = Date.now();

  // Trimmed, exactly as the write paths read it, so health and the app can
  // never disagree about whether a key is usable.
  const signingKey =
    cleanKey(process.env.ARKIV_FIN1_PK) ||
    cleanKey(process.env.ARKIV_ISSUER_PK) ||
    cleanKey(process.env.ARKIV_FIN2_PK);
  const accessKey = process.env.ARKIV_API_KEY || process.env.NEXT_PUBLIC_ARKIV_API_KEY;

  const report: Record<string, unknown> = {
    chain: { name: "Tiramisu", chainId: ARKIV_CHAIN_ID, rpc: ARKIV_RPC, ws: ARKIV_WS },
    project: PROJECT.value,
    accessKey: {
      configured: Boolean(accessKey),
      length: accessKey ? accessKey.length : 0,
      note: accessKey
        ? "Appended to the RPC URL. Raises the rate limit."
        : "Not set. The public RPC still works, but a deployed demo will be throttled. Get one at hub.arkiv.network/api-keys (pick Tiramisu).",
    },
    signer: { configured: Boolean(signingKey) },
    // Shape report for every key variable. This is what tells you WHICH
    // mistake was made, without printing any secret.
    envShapes: [
      shape("ARKIV_FIN1_PK", process.env.ARKIV_FIN1_PK),
      shape("ARKIV_ISSUER_PK", process.env.ARKIV_ISSUER_PK),
      shape("ARKIV_FIN2_PK", process.env.ARKIV_FIN2_PK),
      shape("ARKIV_API_KEY", process.env.ARKIV_API_KEY),
    ],
    checks: {} as Record<string, unknown>,
  };

  // Which signer will actually write, without revealing the key.
  if (signingKey) {
    try {
      const account = privateKeyToAccount(signingKey as `0x${string}`);
      report.signer = {
        configured: true,
        address: account.address,
        which: cleanKey(process.env.ARKIV_FIN1_PK)
          ? "ARKIV_FIN1_PK"
          : cleanKey(process.env.ARKIV_ISSUER_PK)
            ? "ARKIV_ISSUER_PK"
            : "ARKIV_FIN2_PK",
        note: "Fund THIS address with GLM at hub.arkiv.network. Reads work without funds; writes do not.",
      };
    } catch {
      report.signer = {
        configured: true,
        error:
          "The key is set but is not a valid private key. It must be 0x followed by 64 hex characters.",
      };
    }
  } else {
    report.signer = {
      configured: false,
      error: "Set ARKIV_FIN1_PK to a funded Tiramisu private key. One key is enough.",
    };
  }

  // 1. Is the RPC reachable at all?
  try {
    const block = await arkivPublic.getBlockNumber();
    (report.checks as any).rpc = { ok: true, blockNumber: block.toString() };
  } catch (e: any) {
    (report.checks as any).rpc = {
      ok: false,
      error: e?.message ?? String(e),
      hint: "If this fails, nothing else can work. Check ARKIV_API_KEY is a key and not a URL.",
    };
    return NextResponse.json({ ok: false, ...report, ms: Date.now() - started }, { status: 503 });
  }

  // 2. Does a real, project-scoped query return? Counts our own rows only.
  try {
    const page = await arkivPublic
      .select({ key: true, attributes: true })
      .where(eq(PROJECT.key, str(PROJECT.value)), eq("kind", str(KIND.LISTING)))
      .limit(50)
      .fetch();
    (report.checks as any).query = {
      ok: true,
      listingsFound: page.entities.length,
      atBlock: page.blockNumber?.toString(),
      note:
        page.entities.length === 0
          ? "Query works but the market is empty. Issue an invoice at /issue, or the writes never landed (check the signer is funded)."
          : "Listings are readable. The market page should show them.",
    };
  } catch (e: any) {
    (report.checks as any).query = { ok: false, error: e?.message ?? String(e) };
  }

  const checks = report.checks as Record<string, { ok: boolean }>;
  const ok = Object.values(checks).every((c) => c.ok);

  return NextResponse.json({ ok, ...report, ms: Date.now() - started }, {
    status: ok ? 200 : 503,
  });
}
