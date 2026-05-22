import type { ActivityEvent } from './types';
export interface UseActivityReturn {
    events: ActivityEvent[];
    loadHistory: (limit?: number) => void;
}
export declare function useActivity(channel: string): UseActivityReturn;
//# sourceMappingURL=useActivity.d.ts.map