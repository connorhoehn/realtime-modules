"use strict";
// useLiveCaptions — receives `caption` events over the gateway WS and
// maintains an ordered list of recent CaptionLine objects for the
// active call.
//
// Expects the caller to subscribe its own WS handler via the existing
// pattern (HangoutOverlay already does onMessage); this hook is given
// a `subscribe(handler) => unregister` adapter to keep it transport-
// agnostic.
//
// The side-car transcription service (W12 server) is responsible for:
//   - WHEPing one audio stream per participant
//   - Piping PCM to Whisper/Deepgram
//   - Broadcasting CaptionEnvelope frames to the gateway, scoped to a
//     callId/lobbyName
//
// Without the side-car deployed, this hook just sits idle.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useLiveCaptions = useLiveCaptions;
const react_1 = require("react");
function useLiveCaptions({ callId, subscribe, maxLines = 50, }) {
    const [lines, setLines] = (0, react_1.useState)([]);
    (0, react_1.useEffect)(() => {
        if (!callId)
            return;
        const unregister = subscribe((msg) => {
            const m = msg;
            if (m?.type !== 'caption')
                return;
            const d = m.data ?? {};
            if (d.callId !== callId)
                return;
            if (typeof d.text !== 'string' || !d.id || !d.speakerId)
                return;
            const line = {
                id: d.id,
                speakerId: d.speakerId,
                speakerName: d.speakerName,
                text: d.text,
                at: d.at ?? new Date().toISOString(),
                interim: d.interim === true,
            };
            setLines((prev) => {
                // If the caption is an interim update of the same id, replace.
                const idx = prev.findIndex((p) => p.id === line.id);
                if (idx >= 0) {
                    const next = prev.slice();
                    next[idx] = line;
                    return next;
                }
                const next = [...prev, line];
                if (next.length > maxLines)
                    return next.slice(-maxLines);
                return next;
            });
        });
        return unregister;
    }, [callId, subscribe, maxLines]);
    // Drop captions when callId changes (new call).
    (0, react_1.useEffect)(() => { setLines([]); }, [callId]);
    return lines;
}
//# sourceMappingURL=useLiveCaptions.js.map