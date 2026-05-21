import type { GatewayProvider } from './GatewayProvider';
export interface AwarenessFields {
    userId: string;
    displayName: string;
    color: string;
    mode: string;
    currentSectionId: string | null;
    lastSeen: number;
    idle: boolean;
    /** Tiptap cursor display name (may differ from displayName in edge cases). */
    name?: string;
}
export interface AwarenessUpdaters {
    updateSection: (sectionId: string | null) => void;
    updateMode: (mode: string) => void;
    updateIdle: (idle: boolean) => void;
    /** Merge Tiptap-specific cursor info (name, color) without clobbering other fields. */
    updateCursorInfo: (name: string, color: string) => void;
}
export declare function useAwarenessState(provider: GatewayProvider | null, initial: Omit<AwarenessFields, 'lastSeen' | 'idle'>): AwarenessUpdaters;
//# sourceMappingURL=useAwarenessState.d.ts.map