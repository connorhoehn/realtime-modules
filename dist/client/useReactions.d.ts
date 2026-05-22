import type { Reaction } from './types';
export interface UseReactionsReturn {
    reactions: Reaction[];
    react: (emoji: string) => void;
}
export declare function useReactions(channel: string): UseReactionsReturn;
//# sourceMappingURL=useReactions.d.ts.map