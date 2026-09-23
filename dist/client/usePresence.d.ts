import type { PresenceEntry, PresenceStatus } from './types';
export interface UsePresenceReturn {
    roster: PresenceEntry[];
    setStatus: (status: PresenceStatus) => void;
    updateMetadata: (meta: Record<string, unknown>) => void;
}
export interface UsePresenceOptions {
    /**
     * Be present in `channel` while mounted: announce on mount and after every
     * reconnect, and leave (peers are told) on unmount or channel change. The
     * socket's other channels are kept — see `presenceEntry.ts`. Without it the
     * hook only subscribes, and is present only after `setStatus`/`updateMetadata`.
     * Since 0.82.0.
     */
    join?: boolean;
}
export declare function usePresence(channel: string, options?: UsePresenceOptions): UsePresenceReturn;
//# sourceMappingURL=usePresence.d.ts.map