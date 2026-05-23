"use strict";
// useLVSHlsPlayer — pure URL composer for the LVS DVR HLS playback
// endpoint. Returns a ready-to-use playlist URL (m3u8) that consumers
// can hand to `<video src>` (Safari native HLS) or hls.js (everywhere
// else). No DOM manipulation — see <RecordingPlayer> in ui-components
// for the actual playback chrome.
//
// Auth flow: for PUBLIC channels (default), the playlist URL is open
// and `playbackToken` is unnecessary. For PRIVATE channels, callers
// pass a JWT minted by `POST /api/channels/:arn/playback-tokens` (or
// via the platform-api `/api/recordings/:id/playback-token` helper).
// The hook adds `?token=<jwt>` to the URL transparently.
//
// JWT expiry: we decode the token's exp claim and surface `expiresAt`
// so consumers can refresh BEFORE the URL stops working (HLS players
// will fail mid-playback if the token expires while a segment is in
// flight). For simple cases, mint a fresh token before each playback
// session and ignore the refresh.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useLVSHlsPlayer = useLVSHlsPlayer;
const react_1 = require("react");
const LVSProvider_1 = require("./LVSProvider");
const jwt_1 = require("./lib/jwt");
function useLVSHlsPlayer(opts) {
    const ctx = (0, LVSProvider_1.useSafeLVSContext)();
    const baseUrl = opts.baseUrl ?? ctx?.baseUrl ?? '';
    return (0, react_1.useMemo)(() => {
        if (!opts.channelArn || !opts.fromIso || !opts.toIso || !baseUrl) {
            return { playlistUrl: null, tokenExpiresInSec: null, ready: false };
        }
        const params = new URLSearchParams({
            from: opts.fromIso,
            to: opts.toIso,
        });
        if (opts.playbackToken)
            params.set('token', opts.playbackToken);
        const playlistUrl = `${baseUrl}/api/channels/${encodeURIComponent(opts.channelArn)}/dvr/playlist.m3u8?${params}`;
        const tokenExpiresInSec = opts.playbackToken
            ? (0, jwt_1.jwtSecondsRemaining)(opts.playbackToken)
            : null;
        return { playlistUrl, tokenExpiresInSec, ready: true };
    }, [opts.channelArn, opts.fromIso, opts.toIso, opts.playbackToken, baseUrl]);
}
//# sourceMappingURL=useLVSHlsPlayer.js.map