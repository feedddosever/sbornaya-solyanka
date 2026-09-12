"use client";

/**
 * Route shell for /issue.
 *
 * The form is loaded with `ssr: false` on purpose. It reaches Swarm ID, and
 * `@snaha/swarm-id` bundles axios, whose FormData shim dereferences
 * `window.FormData` while the module initialises — so importing it anywhere
 * the server evaluates throws `ReferenceError: window is not defined` and
 * fails `next build` during prerender.
 *
 * Two independent guards keep that from happening:
 *   1. src/swarm/client.ts imports the package dynamically, inside a function
 *      that asserts it is running in a browser (that is the real fix);
 *   2. this boundary, so the component tree is never rendered on the server
 *      at all.
 *
 * Either one is sufficient. Both are here because this build has already been
 * broken twice by the same class of problem, and the cost of the second guard
 * is one skeleton frame.
 */
import dynamic from "next/dynamic";

const IssueForm = dynamic(() => import("./IssueForm"), {
  ssr: false,
  loading: () => (
    <>
      <h1>Issue an invoice</h1>
      <p className="sub">Loading the issuing form…</p>
    </>
  ),
});

export default function IssuePage() {
  return <IssueForm />;
}
