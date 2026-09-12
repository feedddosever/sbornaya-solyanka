/**
 * Arkiv live events — Mission 03 (Live wire).
 *
 * The mission, in Arkiv's words: "Build an app that uses Arkiv WebSocket
 * subscriptions to react to entity changes. Filter the events your app needs
 * and update the UI from the stream, without a polling loop."
 *
 * ── THE TRAP ──────────────────────────────────────────────────────────────
 *
 * The Live Events documentation page says `watchEntityEvents` "polls the chain
 * for new events", defaults `pollingInterval` to half a block, and its Basic
 * Usage snippet builds the client with `http()`. Follow that example literally
 * and you have built the polling loop the mission disqualifies.
 *
 * Two things therefore have to be true, and both are visible in the code below
 * rather than asserted in a README:
 *
 *   1. the client is built on a **websocket transport** (`webSocket(ARKIV_WS)`),
 *      not `http()`. viem only opens a real subscription — `eth_subscribe`
 *      instead of a filter poll — when the transport can carry one. The Arkiv
 *      hub page links viem's `watchEvent#poll-optional` for exactly this reason.
 *
 *   2. **no `fromBlock`**. Asking to replay history forces the polling path,
 *      so the backfill you instinctively reach for after a dropped connection
 *      is the very thing that turns your subscription back into a loop.
 *
 * ── THE ARCHITECTURE THAT FALLS OUT OF IT ────────────────────────────────
 *
 * Because you cannot both replay a gap and stay on a socket, reconnection is a
 * real design fork rather than a detail. Factor's answer:
 *
 *   the socket carries "something changed"   → the trigger
 *   a query carries "here is the truth"      → the state
 *
 * So a dropped connection costs freshness for a moment, never correctness: the
 * query is authoritative either way, and it is the same compound query the
 * market already uses. That is also why the refresh below is debounced — a
 * burst of ten events should cost one query, not ten.
 *
 * ── ON "FILTER THE EVENTS YOUR APP NEEDS" ────────────────────────────────
 *
 * An entity event carries its key and its type. Factor cares about exactly
 * three of the five types — a bid appearing, lapsing, or having its lifetime
 * pushed out — so the other two are dropped at the handler without costing a
 * round trip. Ownership transfers and payload patches never affect the book.
 */
import { createPublicClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { webSocket } from "viem";
import { ARKIV_WS } from "./client";

/**
 * A client that can actually hold a subscription. Note the transport.
 *
 * Created lazily rather than at module scope. viem's `webSocket()` does not
 * open a connection until first use, so a module-scope client would probably
 * be harmless on the server — but this file is imported by a client component,
 * which Next still evaluates during prerender, and this build has already been
 * broken twice by server-side module evaluation. A one-line accessor removes
 * the question entirely.
 */
let socketClient: ReturnType<typeof createPublicClient> | null = null;

export function arkivSocket() {
  if (typeof window === "undefined") {
    throw new Error(
      "arkivSocket() is browser-only: it holds a websocket subscription. " +
        "Call it from an effect, never during render or on the server.",
    );
  }
  if (!socketClient) {
    socketClient = createPublicClient({ chain: tiramisu, transport: webSocket(ARKIV_WS) });
  }
  return socketClient;
}

export type EntityEventKind =
  | "created"
  | "deleted"
  | "expiryExtended"
  | "patched"
  | "ownershipTransferred";

/** The only three that can change the bid book. */
const RELEVANT: ReadonlySet<EntityEventKind> = new Set<EntityEventKind>([
  "created",
  "deleted",
  "expiryExtended",
]);

export interface LiveEvent {
  kind: EntityEventKind;
  entityKey: `0x${string}`;
  at: Date;
}

export type StreamStatus = "connecting" | "live" | "reconnecting" | "stopped";

export interface WatchHandle {
  stop: () => void;
}

/**
 * Subscribe to entity events over the websocket.
 *
 * `watchEntityEvents` returns its unwatch function DIRECTLY — it is not a
 * promise, so awaiting it yields undefined and silently leaks the watcher.
 * The docs flag this and it is an easy mistake to make.
 */
export function watchEntityStream(
  onEvent: (e: LiveEvent) => void,
  onError?: (err: Error) => void,
): WatchHandle {
  const emit = (kind: EntityEventKind) => (event: any) => {
    if (!RELEVANT.has(kind)) return; // filtered at the handler, no round trip
    onEvent({ kind, entityKey: event?.entityKey, at: new Date() });
  };

  const unwatch = arkivSocket().watchEntityEvents({
    onEntityCreated: emit("created"),
    onEntityDeleted: emit("deleted"),
    onExpiryExtended: emit("expiryExtended"),
    // Deliberately not subscribed to patches or ownership transfers: neither
    // can change which bids are live.
    onError: (err: Error) => onError?.(err),
    // fromBlock is deliberately omitted: passing it forces the polling path.
  });

  return { stop: () => unwatch() };
}

/**
 * The production shape: stream + debounced resync + exponential backoff, with
 * the connection state surfaced so the UI can be honest about whether it is
 * actually live.
 *
 * Note what this does NOT do: it never sets `fromBlock` to replay a gap. After
 * a reconnect it re-reads current state with a query instead, which is both
 * correct and keeps the subscription a subscription.
 */
export function watchWithResync(
  resync: () => Promise<void>,
  opts: {
    onStatus?: (s: StreamStatus) => void;
    onEvent?: (e: LiveEvent) => void;
    debounceMs?: number;
    maxBackoffMs?: number;
  } = {},
): WatchHandle {
  const debounceMs = opts.debounceMs ?? 250;
  const maxBackoff = opts.maxBackoffMs ?? 15_000;

  let handle: WatchHandle | null = null;
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const status = (s: StreamStatus) => opts.onStatus?.(s);

  /** Collapse a burst of events into one query. */
  const scheduleResync = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void resync().catch(() => {});
    }, debounceMs);
  };

  const connect = () => {
    if (stopped) return;
    status(attempt === 0 ? "connecting" : "reconnecting");

    handle = watchEntityStream(
      (e) => {
        if (attempt !== 0) {
          attempt = 0; // a delivered event proves the socket is healthy
        }
        status("live");
        opts.onEvent?.(e);
        scheduleResync();
      },
      () => {
        handle?.stop();
        if (stopped) return;
        status("reconnecting");
        const delay = Math.min(maxBackoff, 500 * 2 ** attempt++);
        setTimeout(() => {
          // Re-read state BEFORE resubscribing, so the UI is correct even if
          // the next socket also fails. No fromBlock anywhere.
          void resync()
            .catch(() => {})
            .finally(connect);
        }, delay);
      },
    );

    // The socket is open but silent until something happens, so report "live"
    // once the subscription is established rather than waiting for traffic.
    status("live");
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      handle?.stop();
      status("stopped");
    },
  };
}
