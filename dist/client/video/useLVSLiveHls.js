"use strict";
// useLVSLiveHls — the LIVE half of HLS playback.
//
// ## Why this is separate from useLVSHlsPlayer
//
// That hook composes `/dvr/playlist.m3u8?from=…&to=…`: a TIME WINDOW of a
// recording. It cannot express "what is happening right now" — the window is
// required, and a live viewer has no end time. So the many-viewers broadcast
// case had no hook at all: LVS served `/hls/playlist.m3u8`, and every consumer
// that wanted to watch a live stream had to hand-build the URL.
//
// ## Which transport to use, and why it is a real choice
//
// LVS can deliver the same channel two ways, and they are not
// interchangeable:
//
//   REALTIME (WHEP, `useLVSSubscriber`) — sub-second glass-to-glass, one
//     peer connection per viewer. That per-viewer cost is the point and the
//     limit: it is what makes a CALL work and what makes a thousand-viewer
//     broadcast expensive.
//
//   NEAR-REALTIME (HLS, this hook) — segmented over plain HTTP, so it is
//     cacheable and a CDN can carry it to an audience of any size. The price
//     is latency: a few seconds, set by segment duration.
//
// Rule of thumb: if viewers TALK BACK, they need realtime. If they watch,
// near-realtime is cheaper by orders of magnitude and looks identical.
//
// Like its DVR sibling this is a pure URL composer — no DOM, no player. Hand
// `playlistUrl` to <StreamStage playlistUrl=…> (ui-components), which owns
// the hls.js/native-Safari branch.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useLVSLiveHls = useLVSLiveHls;
const react_1 = require("react");
const LVSProvider_1 = require("./LVSProvider");
const jwt_1 = require("./lib/jwt");
function useLVSLiveHls(opts) {
    const ctx = (0, LVSProvider_1.useSafeLVSContext)();
    const baseUrl = opts.baseUrl ?? ctx?.baseUrl ?? '';
    const { channelArn, playbackToken, abr = true } = opts;
    return (0, react_1.useMemo)(() => {
        if (!channelArn || !baseUrl) {
            return { playlistUrl: null, tokenExpiresInSec: null, ready: false };
        }
        // `master.m3u8` is the ABR entry point; `playlist.m3u8` is the single
        // rendition. LVS serves master through playlist.m3u8 too when ABR is on,
        // but asking for the one we mean keeps the intent readable in a network
        // log — and correct if that aliasing ever changes.
        const file = abr ? 'master.m3u8' : 'playlist.m3u8';
        const qs = playbackToken ? `?token=${encodeURIComponent(playbackToken)}` : '';
        const playlistUrl = `${baseUrl}/api/channels/${encodeURIComponent(channelArn)}/hls/${file}${qs}`;
        return {
            playlistUrl,
            tokenExpiresInSec: playbackToken ? (0, jwt_1.jwtSecondsRemaining)(playbackToken) : null,
            ready: true,
        };
    }, [channelArn, playbackToken, abr, baseUrl]);
}
//# sourceMappingURL=useLVSLiveHls.js.map