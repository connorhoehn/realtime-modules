// realtime-modules/src/client/hangout-rooms/useRoomOccupancy.ts
//
// useRoomOccupancy(slug) — subscribes to the gateway's `rooms:index`
// aggregation stream and returns the live occupancy summary for one
// room.
//
// The gateway broadcasts ONE stream per tab covering ALL rooms' deltas;
// this hook filters client-side by slug. So multiple consumers in the
// same tab can each call `useRoomOccupancy('some-slug')` without
// multiplying the WS subscription cost — the caller wires the single
// stream via `subscribeRoomsIndex` (passed via props or context).
//
// The WS adapter shape is intentionally minimal:
//
//   subscribeRoomsIndex(handler: (occ: RoomOccupancy) => void): () => void
//
// so the hook stays decoupled from the specific gateway WS API. Apps
// using `useGateway()` can wrap it like:
//
//   const subscribe: RoomsIndexSubscriber = (handler) =>
//     onMessage((msg) => {
//       if (msg.type !== 'rooms:occupancy') return;
//       handler(msg.payload as RoomOccupancy);
//     });
//
// State machine:
//   - `slug == null`        → idle, occupancy stays null, no subscription
//   - `slug` set, no event   → occupancy null until first frame arrives
//   - `slug` change          → unsubscribe + resubscribe, reset occupancy
//   - unmount                → unsubscribe

import { useEffect, useState } from 'react';
import type { RoomOccupancy } from './types';

/** Subscriber adapter: caller wires the gateway WS stream + invokes
 *  `handler` with each `RoomOccupancy` delta for any room. Returns an
 *  unsubscribe function. */
export type RoomsIndexSubscriber = (
  handler: (occupancy: RoomOccupancy) => void,
) => () => void;

export interface UseRoomOccupancyOptions {
  /** Gateway adapter — see module docstring. Required for the hook to
   *  receive any data. When omitted the hook stays idle (occupancy=null). */
  subscribeRoomsIndex?: RoomsIndexSubscriber;
}

export interface UseRoomOccupancyResult {
  /** Latest occupancy for `slug`, or null if no event has arrived yet. */
  occupancy: RoomOccupancy | null;
}

/**
 * Subscribe to live occupancy updates for one room. See module
 * docstring for full behavior.
 *
 * Example:
 * ```tsx
 * const { onMessage } = useGateway();
 * const subscribe: RoomsIndexSubscriber = (handler) =>
 *   onMessage((msg) => {
 *     if (msg.type === 'rooms:occupancy') handler(msg.payload as RoomOccupancy);
 *   });
 * const { occupancy } = useRoomOccupancy('general', { subscribeRoomsIndex: subscribe });
 * ```
 */
export function useRoomOccupancy(
  slug: string | null,
  opts: UseRoomOccupancyOptions = {},
): UseRoomOccupancyResult {
  const [occupancy, setOccupancy] = useState<RoomOccupancy | null>(null);

  useEffect(() => {
    // Reset on slug change — stale data from the previous room must not
    // leak into the new tile.
    setOccupancy(null);

    if (!slug) return;
    if (!opts.subscribeRoomsIndex) return;

    const unsubscribe = opts.subscribeRoomsIndex((occ) => {
      if (!occ || occ.slug !== slug) return;
      setOccupancy(occ);
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, opts.subscribeRoomsIndex]);

  return { occupancy };
}
