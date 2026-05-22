import type { PresenceEntry, PresenceStatus } from './types';
export interface UsePresenceReturn {
    roster: PresenceEntry[];
    setStatus: (status: PresenceStatus) => void;
    updateMetadata: (meta: Record<string, unknown>) => void;
}
export declare function usePresence(channel: string): UsePresenceReturn;
//# sourceMappingURL=usePresence.d.ts.map