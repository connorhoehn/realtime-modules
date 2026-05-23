import type { RoomOccupancy } from './types';
/** Subscriber adapter: caller wires the gateway WS stream + invokes
 *  `handler` with each `RoomOccupancy` delta for any room. Returns an
 *  unsubscribe function. */
export type RoomsIndexSubscriber = (handler: (occupancy: RoomOccupancy) => void) => () => void;
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
export declare function useRoomOccupancy(slug: string | null, opts?: UseRoomOccupancyOptions): UseRoomOccupancyResult;
//# sourceMappingURL=useRoomOccupancy.d.ts.map