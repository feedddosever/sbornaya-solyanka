/**
 * Arkiv live events — Mission 03 (Live wire).
 *
 * THE TRAP, stated plainly. The Live Events documentation page says
 * `watchEntityEvents` "polls the chain for new events", its `pollingInterval`
 * defaults to half a block, and its example builds the client with `http()`.
 * Follow that example literally and you have built a polling loop — which is
 * precisely what Mission 03 disqualifies ("update the UI from the stream,
 * without a polling loop").
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
 * Reconnection is therefore a genuine design problem rather than a detail: you
 * cannot both replay a gap and stay on a socket. Factor's answer is below.
 */
import { createPublicClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { webSocket } from "viem";
import { ARKIV_WS } from "./client";

/** A client that can actually hold a subscription. Note the transport. */
export const arkivSocket = createPublicClient({
  chain: tiramisu,
  transport: webSocket(ARKIV_WS),
});

export type EntityEventKind =
  | "created"
  | "patched"
  | "deleted"
  | "expiryExtended"
  | "ownershipTransferred";

export interface LiveEvent {
  kind: EntityEventKind;
  entityKey: `0x${string}`;
  at: Date;
}

export interface WatchHandle {
  stop: () => void;
}

/**
 * Follow the bid book from the stream.
 *
 * `watchEntityEvents` returns its unwatch function DIRECTLY — it is not a
 * promise, so awaiting it yields undefined and silently leaks the watcher.
 * The docs flag this and it is an easy mistake to make.
 */
export function watchBidBook(
  onEvent: (e: LiveEvent) => void,
  onError?: (err: Error) => void,
): WatchHandle {
  const mk = (kind: EntityEventKind) => (event: any) =>
    onEvent({ kind, entityKey: event.entityKey, at: new Date() });

  const unwatch = arkivSocket.watchEntityEvents({
    onEntityCreated: mk("created"),
    onEntityPatched: mk("patched"),
    onEntityDeleted: mk("deleted"),
    onExpiryExtended: mk("expiryExtended"),
    onOwnershipTransferred: mk("ownershipTransferred"),
    onError: (err: Error) => {
      // Default is console.error, which would swallow a dropped socket.
      onError?.(err);
    },
    // fromBlock is deliberately omitted: passing it forces the polling path.
  });

  return { stop: () => unwatch() };
}

/**
 * Reconnection without falling back to polling.
 *
 * The instinct after a dropped connection is to replay from the last block you
 * saw. That sets `fromBlock`, which forces polling — so it trades the mission
 * requirement for completeness. Factor does the opposite: resubscribe with no
 * `fromBlock`, and close the gap with a one-shot **query** instead of a replay.
 *
 * That split is the honest architecture. The socket carries "something
 * changed"; the query carries "here is the current truth". A gap in the stream
 * costs freshness for a moment, never correctness, because the query is
 * authoritative either way.
 */
export function watchWithResync(
  onEvent: (e: LiveEvent) => void,
  resync: () => Promise<void>,
  opts: { maxBackoffMs?: number } = {},
): WatchHandle {
  const maxBackoff = opts.maxBackoffMs ?? 15_000;
  let attempt = 0;
  let handle: WatchHandle | null = null;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    handle = watchBidBook(
      (e) => {
        attempt = 0; // a delivered event means the socket is healthy
        onEvent(e);
      },
      () => {
        handle?.stop();
        if (stopped) return;
        const delay = Math.min(maxBackoff, 500 * 2 ** attempt++);
        setTimeout(async () => {
          // Re-read state BEFORE resubscribing, so the UI is correct even if
          // the next socket also fails. No fromBlock anywhere.
          await resync().catch(() => {});
          connect();
        }, delay);
      },
    );
  };

  connect();
  return {
    stop: () => {
      stopped = true;
      handle?.stop();
    },
  };
}
