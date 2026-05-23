"use strict";
// Shared SDP / RTC helpers used by both publisher (WHIP) and subscriber
// (WHEP) hooks. Pure functions over RTCPeerConnection — no React.
Object.defineProperty(exports, "__esModule", { value: true });
exports.waitForIceGather = waitForIceGather;
exports.formatBitrate = formatBitrate;
exports.classifyNetQ = classifyNetQ;
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
function waitForIceGather(pc, timeoutMs = 3000) {
    return new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') {
            resolve('complete');
            return;
        }
        let done = false;
        const finish = () => {
            if (done)
                return;
            done = true;
            pc.removeEventListener('icegatheringstatechange', onChange);
            clearTimeout(timer);
            resolve(pc.iceGatheringState);
        };
        const onChange = () => {
            if (pc.iceGatheringState === 'complete')
                finish();
        };
        pc.addEventListener('icegatheringstatechange', onChange);
        const timer = setTimeout(finish, timeoutMs);
    });
}
/**
 * Format a bitrate (bits per second) into a human-readable string.
 * "1.2 Mbps", "640 kbps", "—" for zero/null.
 */
function formatBitrate(bps) {
    if (!bps || bps <= 0)
        return '—';
    if (bps >= 1_000_000)
        return `${(bps / 1_000_000).toFixed(1)} Mbps`;
    if (bps >= 1_000)
        return `${Math.round(bps / 1_000)} kbps`;
    return `${Math.round(bps)} bps`;
}
/**
 * Classify network quality from packet-loss percentage (0-100).
 * Thresholds match LVS demo's `netq` semantics.
 */
function classifyNetQ(lossPct, hasRecentPackets) {
    if (!hasRecentPackets)
        return 'dead';
    if (lossPct < 2)
        return 'good';
    if (lossPct < 5)
        return 'medium';
    return 'poor';
}
//# sourceMappingURL=sdp.js.map