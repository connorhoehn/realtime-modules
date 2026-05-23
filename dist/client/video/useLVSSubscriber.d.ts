import { type NetQuality } from './lib/sdp';
export type LVSSubscriberPhase = 'idle' | 'connecting' | 'live' | 'failed' | 'reconnecting';
export interface LVSSubscriberStats {
    bitrateBps: number;
    bitrateLabel: string;
    fps: number | null;
    lossPct: number;
    netq: NetQuality | null;
    bytesReceived: number;
    packetsReceived: number;
    packetsLost: number;
    width: number;
    height: number;
}
export interface UseLVSSubscriberOptions {
    /** Channel ARN — `${baseUrl}/api/channels/:arn/whep`. */
    channelArn: string;
    /** Auto-connect on mount. Default true. */
    autoStart?: boolean;
    /** Skip self via excludeParticipantId — passed to whep server so its
     *  SDP answer never includes our own published tracks. Hangout-essential. */
    excludeParticipantId?: string;
    baseUrl?: string;
    getAuthToken?: () => string | Promise<string>;
    /** Per-track callback — fires on every inbound track. The second arg
     *  is the track's `streams[0].id` (msid), typically the SFU-assigned
     *  participantId. Lets consumers route tracks into per-participant
     *  tiles when WHEP multiplexes many publishers into one PC. */
    onTrack?: (track: MediaStreamTrack, participantId: string | null) => void;
    /** When true, opens an auxiliary WebSocket to LVS's producer-
     *  discovery channel (`/api/channels/:arn/ws`) and triggers a
     *  re-WHEP whenever a producer of a NEW kind is announced. This is
     *  how subscribers pick up an audio-only publisher's upgrade to
     *  video — WHEP itself has no push channel for new producers. */
    watchProducerEvents?: boolean;
}
export interface UseLVSSubscriberResult {
    phase: LVSSubscriberPhase;
    error: string | null;
    iceState: RTCIceConnectionState;
    connState: RTCPeerConnectionState;
    stats: LVSSubscriberStats | null;
    sfuNode: string | null;
    /** Aggregated MediaStream of all inbound tracks. Pass to a <video>
     *  element via srcObject. */
    stream: MediaStream | null;
    /** Per-track map keyed by trackId. Lets consumers split multiplexed
     *  remote-tracks-per-publisher into per-participant tiles. */
    tracks: ReadonlyMap<string, MediaStreamTrack>;
    start: () => Promise<void>;
    stop: () => Promise<void>;
}
/**
 * Subscribe to an LVS channel via WHEP. Manages the RTCPeerConnection
 * lifecycle (two recvonly transceivers → offer/answer → stats poll →
 * reconnect ladder → teardown). Exposes an aggregated `MediaStream`
 * for direct `<video srcObject>` binding plus a `Map<trackId, track>`
 * for per-participant tile routing in hangouts.
 *
 * Reconnect ladder: `[1, 2, 4, 8, 16, 30]s`, max 5 attempts. Triggered
 * on `connectionState === 'failed' | 'disconnected'`. Each attempt
 * tears down the prior PC + WHEP resource before reconnecting.
 */
export declare function useLVSSubscriber(opts: UseLVSSubscriberOptions): UseLVSSubscriberResult;
//# sourceMappingURL=useLVSSubscriber.d.ts.map