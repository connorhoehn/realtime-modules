/**
 * Wait for ICE gathering to reach 'complete', capped at `timeoutMs`.
 * Returns the gather state at the time we stopped waiting. Used to
 * avoid trickle ICE — LVS doesn't support PATCH/trickle, so we batch
 * candidates into the offer before sending it.
 *
 * Typical timing on a single-host candidate (localhost loopback):
 * gathering completes in <50ms. The 3s timeout is the LVS demo's
 * default — preserved here.
 */
export declare function waitForIceGather(pc: RTCPeerConnection, timeoutMs?: number): Promise<RTCIceGatheringState>;
/**
 * Format a bitrate (bits per second) into a human-readable string.
 * "1.2 Mbps", "640 kbps", "—" for zero/null.
 */
export declare function formatBitrate(bps: number | null | undefined): string;
export type NetQuality = 'good' | 'medium' | 'poor' | 'dead';
/**
 * Classify network quality from packet-loss percentage (0-100).
 * Thresholds match LVS demo's `netq` semantics.
 */
export declare function classifyNetQ(lossPct: number, hasRecentPackets: boolean): NetQuality;
//# sourceMappingURL=sdp.d.ts.map