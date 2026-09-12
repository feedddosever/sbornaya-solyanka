/**
 * Diagnostic: what does the Arkiv websocket actually push?
 *
 * Three subscriptions at once, so a silent one can be told apart from a silent
 * socket:
 *   A  newHeads                      — proves push delivery works at all
 *   B  logs { address: ENGINE }      — engine logs, no topic filter
 *   C  logs {}                       — everything
 *
 * Then one entity is created through the deployed API, and everything that
 * arrives for 60s is printed with its subscription label.
 */
const WS_URL = "wss://rpc.tiramisu.db-chain.testnet.arkiv.network";
const BASE = process.argv[2] ?? "https://sbornaya-solyanka-9fbt-seven.vercel.app";
const ENGINE = "0x4400000000000000000000000000000000000044";

const subs = new Map(); // subscription id -> label
const counts = { A: 0, B: 0, C: 0 };
let expectedKey = null;

const ws = new WebSocket(WS_URL);

ws.addEventListener("open", () => {
  console.log("  socket open");
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "eth_subscribe", params: ["newHeads"] }));
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "eth_subscribe", params: ["logs", { address: ENGINE }] }));
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 12, method: "eth_subscribe", params: ["logs", {}] }));
});

ws.addEventListener("message", async (ev) => {
  const m = JSON.parse(ev.data);

  if (m.id >= 10 && m.id <= 12) {
    const label = { 10: "A newHeads", 11: "B logs@engine", 12: "C logs all" }[m.id];
    if (m.error) return console.log(`  ${label}: REJECTED ${JSON.stringify(m.error)}`);
    subs.set(m.result, label);
    console.log(`  ${label}: subscribed ${m.result}`);
    if (subs.size === 3) {
      console.log("\n  writing one bid ...");
      const r = await fetch(`${BASE}/api/arkiv/bids`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          invoiceId: String(9500 + Math.floor(Math.random() * 400)), financierSlot: 1,
          financier: "0x2A058020fa86281b6695Fad49c302182ec8aeA34", discountBps: 450,
          offerPrice: "9550.00", sector: "logistics", ensName: "probe.factor.eth",
          ttlSeconds: 40,
        }),
      });
      const d = await r.json();
      expectedKey = (d.entityKey ?? "").toLowerCase();
      console.log("  entity", d.entityKey ?? d.error, "\n");
    }
    return;
  }

  if (m.method === "eth_subscription") {
    const label = subs.get(m.params.subscription) ?? "?";
    const key = label[0];
    counts[key] = (counts[key] ?? 0) + 1;
    const r = m.params.result;
    if (label.startsWith("A")) {
      if (counts.A <= 2) console.log(`  [${label}] block ${parseInt(r.number, 16)}`);
    } else {
      const t1 = (r.topics?.[1] ?? "").toLowerCase();
      const mine = expectedKey && t1 === expectedKey ? "  <== OUR ENTITY" : "";
      if (counts[key] <= 6 || mine)
        console.log(`  [${label}] block ${parseInt(r.blockNumber, 16)} addr ${r.address} topic0 ${(r.topics?.[0] ?? "").slice(0, 18)}…${mine}`);
    }
  }
});

setTimeout(() => {
  console.log("\n  --- totals over 60s ---");
  console.log(`    A newHeads    : ${counts.A}`);
  console.log(`    B logs@engine : ${counts.B}`);
  console.log(`    C logs all    : ${counts.C}`);
  ws.close();
  process.exit(0);
}, 60_000);
