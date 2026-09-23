import type { PresenceStatus } from './types';
/** Metadata key that names the channels an entry is leaving. */
export declare const PRESENCE_LEFT_KEY = "_left";
export type PresenceSetFrame = {
    service: 'presence';
    action: 'set';
    status: PresenceStatus;
    metadata: Record<string, unknown>;
    channels: string[];
};
export interface PresencePatch {
    status?: PresenceStatus | string;
    /** Merged into the entry's metadata; a `null` value removes the key. */
    metadata?: Record<string, unknown>;
    /**
     * Channels to list in THIS frame even if nobody joined them (the legacy
     * one-channel `setStatus`/`updateMetadata` behaviour). Not remembered.
     */
    alsoChannels?: readonly string[];
}
/** The channels this socket is present in, in join order. */
export declare function joinedPresenceChannels(): string[];
/**
 * Be present in `channel`. Returns a release; the release answers true when it
 * dropped the LAST reference (the caller should then send `presenceLeaveFrames`).
 */
export declare function joinPresenceChannel(channel: string): () => boolean;
/** Apply a patch and build the full `set` frame for the socket's entry. */
export declare function presenceSetFrame(patch?: PresencePatch): PresenceSetFrame;
/**
 * The two frames that take this socket out of `channel` (already released
 * from `joinPresenceChannel`). See "Leaving a channel" above.
 */
export declare function presenceLeaveFrames(channel: string, patch?: Pick<PresencePatch, 'metadata'>): PresenceSetFrame[];
/** Test-only: forget every join, the status and the metadata. */
export declare function resetPresenceEntry(): void;
//# sourceMappingURL=presenceEntry.d.ts.map