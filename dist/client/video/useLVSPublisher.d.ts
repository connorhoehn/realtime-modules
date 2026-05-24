import { type NetQuality } from './lib/sdp';
export type LVSPhase = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error';
export interface LVSPublisherStats {
    bitrateBps: number;
    bitrateLabel: string;
    fps: number | null;
    lossPct: number;
    netq: NetQuality | null;
    bytesSent: number;
    packetsSent: number;
}
export interface UseLVSPublisherOptions {
    /** Channel ARN — used to build `${baseUrl}/api/channels/:arn/whip`. */
    channelArn: string;
    /** MediaStream to publish. Caller owns capture (getUserMedia /
     *  getDisplayMedia). Null parks the hook in idle. */
    stream: MediaStream | null;
    /** Per-tab participantId — forwarded as `?participantId=X` so WHEP
     *  subscribers can correlate this publisher. Required for hangouts. */
    participantId?: string;
    /** Auto-publish on mount once stream is non-null. Default true. */
    autoStart?: boolean;
    /** Override baseUrl from LVSProvider. */
    baseUrl?: string;
    /** Override getAuthToken from LVSProvider. */
    getAuthToken?: () => string | Promise<string>;
}
export interface UseLVSPublisherResult {
    phase: LVSPhase;
    error: string | null;
    iceState: RTCIceConnectionState;
    connState: RTCPeerConnectionState;
    stats: LVSPublisherStats | null;
    sfuNode: string | null;
    whipResource: string | null;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    /** Replace tracks on existing senders without renegotiating. Useful
     *  for cam <-> screen-share swap. New tracks must match the existing
     *  transceivers' kind (audio/video). */
    replaceStream: (newStream: MediaStream) => Promise<void>;
    /** Tear down + re-WHIP with a new stream. Used to add/remove track
     *  KINDS mid-call (e.g. audio-only → AV upgrade), which `replaceStream`
     *  alone can't do (LVS WHIP doesn't support PATCH for renegotiation).
     *  Same participantId is preserved so subscribers' tile routing stays
     *  intact. ~500ms-1s gap while ICE+DTLS re-handshakes. */
    republish: (newStream: MediaStream) => Promise<void>;
}
/**
 * Publish a `MediaStream` to an LVS-compatible SFU via WHIP. Owns the
 * `RTCPeerConnection` lifecycle, polls outbound-rtp stats, and runs a
 * watchdog that flips to `error` if no media flows within ~20s.
 *
 * The caller owns capture (camera/screen) and preview rendering. The
 * hook only touches the network and the PC; pass a `stream` and call
 * `start()` (or rely on `autoStart`).
 */
export declare function useLVSPublisher(opts: UseLVSPublisherOptions): UseLVSPublisherResult;
//# sourceMappingURL=useLVSPublisher.d.ts.map