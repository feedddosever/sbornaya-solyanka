"use client";

/**
 * Issuing an invoice — where all four layers touch in one flow.
 *
 * The document handling here is the part worth reading. The naive version puts
 * the encrypted Swarm reference into the Arkiv listing, which would publish
 * every invoice in the system: an encrypted reference is 128 hex characters
 * with the decryption key embedded, and Arkiv entities are public by design.
 * So: a public redacted teaser powers discovery, a keccak256 commitment goes
 * on-chain, and the real reference stays secret until it is sealed to the
 * buyer's ENSv2 public key after the sale.
 */
import { useEffect, useState } from "react";
import {
  initSwarm,
  connectSwarm,
  uploadInvoiceDocument,
  uploadTeaser,
  uploadBlockedReason,
} from "@/swarm/client";
import { commitToReference } from "@/swarm/seal";
import { CLAIM_ADDRESS, issueInvoice, explorerTx } from "@/fuji/claim";

type Step = "idle" | "swarm" | "chain" | "index" | "done";

export default function Issue() {
  const [info, setInfo] = useState<any>(null);
  const [file, setFile] = useState<File | null>(null);
  const [debtor, setDebtor] = useState("");
  const [faceValue, setFaceValue] = useState("12500.00");
  const [sector, setSector] = useState("logistics");
  const [rating, setRating] = useState("3");
  const [dueDays, setDueDays] = useState("45");
  const [ensName, setEnsName] = useState("acme.factor.eth");

  const [step, setStep] = useState<Step>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{
    docCommit: string;
    teaserRef: string;
    txHash: string;
    entityKey: string;
  } | null>(null);

  // Swarm ID must be initialised before anything else — it creates the hidden
  // iframe that holds all key material.
  useEffect(() => {
    initSwarm(setInfo).catch((e) => setErr(`Swarm ID init failed: ${e.message}`));
  }, []);

  const blocked = uploadBlockedReason(info);

  async function signIn() {
    setErr(null);
    try {
      const i = await connectSwarm();
      setInfo(i);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function submit() {
    setErr(null);
    setResult(null);
    if (!file) return setErr("Attach the invoice PDF first.");
    if (!debtor.startsWith("0x")) return setErr("Enter the debtor's address.");

    try {
      // ---- 1. Swarm: the public teaser and the private document ----------
      setStep("swarm");
      const dueDate = new Date(Date.now() + Number(dueDays) * 86400_000);

      // Redacted on purpose: a band rather than the amount, a month rather
      // than the date, and no counterparty names. This is the only part that
      // becomes public.
      const teaser = await uploadTeaser({
        sector,
        faceValueBand: band(Number(faceValue)),
        dueMonth: dueDate.toISOString().slice(0, 7),
        ratingBand: Number(rating),
        issuer: ensName,
        note: "Redacted summary. Full invoice released to the buyer after sale.",
      });

      const doc = await uploadInvoiceDocument(file);
      const docCommit = commitToReference(doc.reference);

      // The reference itself never leaves this function. Keep it where only
      // the issuer can reach it until there is a buyer to seal it to.
      sessionStorage.setItem(`factor:ref:pending`, doc.reference);

      // ---- 2. Avalanche: the claim, committing to the document -----------
      setStep("chain");
      const [account] = (await (window as any).ethereum.request({
        method: "eth_requestAccounts",
      })) as `0x${string}`[];

      const txHash = await issueInvoice({
        account,
        debtor: debtor as `0x${string}`,
        faceValueHuman: faceValue,
        dueDate,
        docHash: docCommit,
      });

      // ---- 3. Arkiv: the queryable index --------------------------------
      setStep("index");
      // In a fuller build, read the minted id from the Issued event; for the
      // demo the deploy script keeps ids sequential and small.
      const invoiceId = prompt("Token id from the Issued event?") ?? "1";

      const listed = await fetch("/api/arkiv/listings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          invoiceId,
          issuer: account,
          debtor,
          sector,
          faceValue,
          dueDate: Math.floor(dueDate.getTime() / 1000),
          ratingBand: Number(rating),
          teaserRef: teaser.reference,
          docCommit,
          claimContract: CLAIM_ADDRESS,
          ensName,
        }),
      }).then((r) => r.json());

      if (listed.error) throw new Error(listed.error);

      setResult({
        docCommit,
        teaserRef: teaser.reference,
        txHash,
        entityKey: listed.entityKey,
      });
      setStep("done");
    } catch (e: any) {
      setErr(e?.shortMessage ?? e.message ?? String(e));
      setStep("idle");
    }
  }

  return (
    <>
      <h1>Issue an invoice</h1>
      <p className="sub">
        The document is encrypted and stays yours. Only a redacted summary and a hash become
        public — the full invoice is released to the financier who buys the claim, sealed to the
        public key on their ENS name.
      </p>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span>
            <span className="tag swarm">swarm id</span>{" "}
            {info?.identity ? (
              <span className="mono">
                {info.identity.name || info.identity.address?.slice(0, 12)} · {info.uploadMode}
              </span>
            ) : (
              <span className="note">not signed in</span>
            )}
          </span>
          {!info?.identity && <button onClick={signIn}>Sign in with a passkey</button>}
        </div>
        {blocked && info?.identity && <div className="err">{blocked}</div>}
      </div>

      <h2>Terms</h2>
      <div className="filters">
        <label>
          Debtor address (Fuji)
          <input value={debtor} onChange={(e) => setDebtor(e.target.value)} placeholder="0x…" />
        </label>
        <label>
          Face value (FUSD)
          <input value={faceValue} onChange={(e) => setFaceValue(e.target.value)} />
        </label>
        <label>
          Due in (days)
          <input value={dueDays} onChange={(e) => setDueDays(e.target.value)} />
        </label>
        <label>
          Sector
          <input value={sector} onChange={(e) => setSector(e.target.value)} />
        </label>
        <label>
          Rating band (1-5)
          <input value={rating} onChange={(e) => setRating(e.target.value)} />
        </label>
        <label>
          Your ENS name
          <input value={ensName} onChange={(e) => setEnsName(e.target.value)} />
        </label>
      </div>

      <h2>The document</h2>
      <div className="card">
        <input
          type="file"
          accept="application/pdf,image/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <p className="note">
          Uploaded encrypted. The 128-character reference carries its own decryption key, so it is
          never written to Arkiv or on-chain — only <code>keccak256</code> of it.
        </p>
      </div>

      {err && <div className="err">{err}</div>}

      <div className="row" style={{ marginTop: 20 }}>
        <button disabled={step !== "idle" && step !== "done"} onClick={submit}>
          {step === "idle" || step === "done" ? "Issue the claim" : label(step)}
        </button>
        {step !== "idle" && step !== "done" && <span className="note">{label(step)}</span>}
      </div>

      {result && (
        <div className="ok" style={{ marginTop: 20 }}>
          <strong>Issued.</strong>
          <div className="mono" style={{ marginTop: 8 }}>
            fuji tx &nbsp;
            <a className="link" href={explorerTx(result.txHash)} target="_blank" rel="noreferrer">
              {result.txHash.slice(0, 24)}…
            </a>
            <br />
            docCommit &nbsp;{result.docCommit.slice(0, 30)}…
            <br />
            teaser (public) &nbsp;{result.teaserRef.slice(0, 30)}…
            <br />
            arkiv listing &nbsp;{result.entityKey.slice(0, 30)}…
          </div>
          <p className="note">
            The encrypted document reference is held locally and never published. It will be sealed
            to the buyer&apos;s ENSv2 <code>pubkey</code> record once a bid is accepted.
          </p>
        </div>
      )}
    </>
  );
}

const label = (s: Step) =>
  ({
    idle: "",
    swarm: "Uploading to Swarm…",
    chain: "Issuing on Fuji…",
    index: "Publishing the Arkiv listing…",
    done: "Done",
  })[s];

/** Redaction helper: publish a band, never the amount. */
function band(v: number): string {
  if (v < 5_000) return "under 5k";
  if (v < 10_000) return "5k-10k";
  if (v < 25_000) return "10k-25k";
  if (v < 100_000) return "25k-100k";
  return "over 100k";
}
