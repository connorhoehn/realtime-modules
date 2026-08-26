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

import { useEffect, useState } from 'react';

export interface CaptionLine {
  id: string;
  speakerId: string;
  speakerName?: string;
  text: string;
  at: string; // ISO
  interim?: boolean;
}

export interface UseLiveCaptionsOptions {
  /** Scope captions to this call. Caption envelopes for other calls
   *  in the same WS are ignored. Optional when `channel` is given. */
  callId?: string | null;
  /**
   * Scope captions to a WS channel instead of a call.
   *
   * The live-captions sidecar is a generic speech-to-text service — its
   * `X-Channel-Arn` is free-form and the gateway relay fans every
   * `captions:*` publish out to `captions:<sha1(key)[:24]>`. Ambient
   * (non-call) capture therefore produces caption frames with no `callId`
   * at all, and the call-scoped filter below would drop every one of them.
   * Pass the channel and lines are matched on the frame's `channel` field.
   *
   * When both are given, `channel` wins.
   */
  channel?: string | null;
  /** Subscribe to the gateway WS. Returns an unsubscribe fn. */
  subscribe: (handler: (msg: unknown) => void) => () => void;
  /** Maximum lines retained in memory. Default 50. */
  maxLines?: number;
}

interface CaptionMessage {
  type?: string;
  action?: string;
  channel?: string;
  data?: {
    callId?: string;
    id?: string;
    speakerId?: string;
    /** The sidecar's own field name for the same thing. */
    participantId?: string;
    speakerName?: string;
    text?: string;
    at?: string;
    interim?: boolean;
  };
}

export function useLiveCaptions({
  callId,
  channel,
  subscribe,
  maxLines = 50,
}: UseLiveCaptionsOptions): CaptionLine[] {
  const [lines, setLines] = useState<CaptionLine[]>([]);
  const scope = channel ?? callId ?? null;

  useEffect(() => {
    if (!scope) return;
    const unregister = subscribe((msg: unknown) => {
      const m = msg as CaptionMessage;
      if (m?.type !== 'caption') return;
      const d = m.data ?? {};
      if (channel) {
        if (m.channel !== channel) return;
      } else if (d.callId !== callId) {
        return;
      }
      const speakerId = d.speakerId ?? d.participantId;
      if (typeof d.text !== 'string' || !d.id || !speakerId) return;
      const line: CaptionLine = {
        id: d.id,
        speakerId,
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
        if (next.length > maxLines) return next.slice(-maxLines);
        return next;
      });
    });
    return unregister;
  }, [scope, callId, channel, subscribe, maxLines]);

  // Drop captions when the scope changes (new call, or new capture channel).
  useEffect(() => { setLines([]); }, [scope]);

  return lines;
}
