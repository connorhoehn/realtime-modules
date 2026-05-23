export interface UseLVSHangoutOptions {
    /** Participant token from platform-api `/api/video/sessions/:id/join`.
     *  Decoded to extract the `arn` claim (the SFU channel ARN). */
    stageToken: string | null;
    /** SFU-issued participant id (per-tab unique). */
    participantId: string | null;
    /** Display name for the local user. */
    userId: string;
    /** Media constraints for getUserMedia. Defaults to { video: 720p, audio: true }. */
    media?: MediaStreamConstraints;
    /** Override base URL (else read from LVSProvider). */
    baseUrl?: string;
    /** Override token resolver. The default resolver returns `stageToken` itself. */
    getAuthToken?: () => string | Promise<string>;
}
export interface HangoutParticipant {
    /** Stable per-tab id (the publisher's WHIP participantId or, for remotes,
     *  the SDP msid label). */
    participantId: string;
    /** Display name. For remotes, falls back to participantId. */
    displayName: string;
    /** True for the local user. */
    isLocal: boolean;
    /** Per-participant streams — usually `[cameraStream]`. Empty array while
     *  remote hasn't yet produced. Note: `screenStream` is exposed
     *  separately below so consumers can route it into a spotlight slot
     *  while keeping the camera tile alive as a PiP. */
    streams: MediaStream[];
    /** Active screen-share stream, if any. For the local user, populated
     *  by `startScreenShare()`. For remotes, populated by the dedicated
     *  parallel-WHEP PC opened against the `${pid}:screen` producer.
     *  Undefined when not sharing. */
    screenStream?: MediaStream;
    /** Alias retained for legacy ui-components consumers — same as
     *  `displayName`. Some downstream components key on `userId`. */
    userId: string;
    /** Convenience: is any audio track currently enabled? */
    hasAudio: boolean;
    /** Convenience: is any video track currently enabled? */
    hasVideo: boolean;
}
export interface UseLVSHangoutResult {
    participants: HangoutParticipant[];
    isJoined: boolean;
    isScreenSharing: boolean;
    isCameraEnabled: boolean;
    error: string | null;
    toggleMute: (muted: boolean) => void;
    /** Flip the local camera track's `enabled` flag — no SDP churn.
     *  Remote will see a black frame / frozen last frame. Use this for
     *  mid-call mute. For ADD/REMOVE of the video track itself (true
     *  upgrade/downgrade), call `enableCamera()` / `disableCamera()`. */
    toggleCamera: (off: boolean) => void;
    /** Acquire camera + add to the publish stream via re-WHIP. Used when
     *  the call started audio-only and the user wants to turn video on.
     *  Costs ~500ms-1s gap while ICE+DTLS re-handshakes. Idempotent —
     *  no-op when camera is already published. */
    enableCamera: () => Promise<void>;
    /** Drop the camera track + re-publish audio-only. Subscribers will
     *  see the video producer disappear (via `producer.removed`). */
    disableCamera: () => Promise<void>;
    startScreenShare: () => Promise<void>;
    stopScreenShare: () => void;
    leave: () => void;
}
/**
 * Composite hangout hook. Wires WHIP (useLVSPublisher) + per-remote
 * parallel WHEP PCs into a single participants-list API matching the
 * legacy IVS-Stage-based useHangoutEmbed surface, so consumers
 * (HangoutOverlay, HangoutDemoPage, VideoCallPanel) can swap with a
 * one-line import change.
 *
 * Lifecycle:
 *   - idle while `stageToken` or `participantId` is null
 *   - acquires camera+mic via getUserMedia on first valid input
 *   - autostarts publisher
 *   - opens the discovery WS; for every remote producer.added event
 *     (camera OR `:screen`) opens a dedicated WHEP PC targeting that
 *     publisher's pid with the positive selector. The SFU's
 *     `findProducerOfKind(arn, kind, participantId)` returns ONLY
 *     that publisher's tracks, so each remote peer gets its own PC
 *     and its own tile.
 *   - `leave()` releases all local tracks + tears down every parallel PC
 *   - unmount cleanup mirrors `leave()` (idempotent)
 *
 * Track routing: each parallel PC's onTrack carries that remote's
 * camera (or screen) tracks. We attach them to the participant entry
 * keyed by the remote's BASE pid (`fullPid.split(':')[0]`); a peer's
 * camera + screen end up on the same participant entry — camera in
 * `streams[]`, screen in `screenStream` — so a single peer never
 * appears as two tiles.
 */
export declare function useLVSHangout(opts: UseLVSHangoutOptions): UseLVSHangoutResult;
//# sourceMappingURL=useLVSHangout.d.ts.map