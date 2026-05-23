import { type NetQuality } from './lib/sdp';
/**
 * Subscriber lifecycle phase.
 *
 * - `idle` — not connected, no start() yet (or post-stop()).
 * - `connecting` — WHEP handshake in flight.
 * - `live` — PC has reached `connected`; tracks are flowing.
 * - `reconnecting` — transient ICE/PC failure; ladder will retry.
 * - `waiting-for-producer` — WHEP returned 409 (no producers yet on the
 *   channel). Not a failure: the SFU is healthy, just nothing to
 *   subscribe to. Sticks until a `producer.added` event arrives on the
 *   discovery WS (or the 60s slow-poll succeeds), then auto-transitions
 *   back through `connecting` → `live`. No ladder budget consumed.
 * - `failed` — terminal. Either a 4xx-class client/server bug
 *   (404/415), or the network ladder exhausted. The discovery WS
 *   watcher MAY still resume the subscriber if the last failure was
 *   transient (i.e. ladder ran out on 409s + 5xx); the watcher will
 *   not resume after 404/415.
 */
export type LVSSubscriberPhase = 'idle' | 'connecting' | 'live' | 'failed' | 'reconnecting' | 'waiting-for-producer';
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
 * Failure-class routing in the WHEP catch block:
 * - 409 → `waiting-for-producer`. No ladder, no budget consumed. Waits
 *   for `producer.added` on the discovery WS OR the 60s slow-poll.
 * - 503 → honor `Retry-After` with a single delayed retry. No budget.
 * - 404 / 415 → terminal `failed` (client/server contract bug).
 * - 500, fetch failures, ICE drops → exponential network-reconnect
 *   ladder: `[1, 2, 4, 8, 16, 30]s`, max 5 attempts.
 *
 * The two budgets are independent: a long ring with 100 consecutive
 * 409s does NOT eat the network-reconnect budget, so a real network
 * drop later still gets its full 5 attempts.
 */
export declare function useLVSSubscriber(opts: UseLVSSubscriberOptions): UseLVSSubscriberResult;
//# sourceMappingURL=useLVSSubscriber.d.ts.map