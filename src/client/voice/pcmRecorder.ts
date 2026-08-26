// realtime-modules/src/client/voice/pcmRecorder.ts
//
// getUserMedia -> AudioWorklet -> 16 kHz mono s16le chunks.
//
// This is the ONE place in the toolkit that opens a microphone outside a call.
// Two things about it are load-bearing and must not be "optimised" away:
//
//  1. `stop()` calls track.stop() on every track and closes the AudioContext.
//     Merely disconnecting the node, or keeping the stream around "for the next
//     press", leaves the OS/browser recording indicator lit while our own UI
//     says we are not listening. The W3C treats the indicator as normative, and
//     a UI that disagrees with it is the exact behaviour that made In re
//     Otter.AI (N.D. Cal., 13 Aug 2026) a §631 case rather than a feature
//     complaint. The track is acquired per press and released per release.
//  2. The PCM is never retained. Each chunk is handed to the sink and dropped.
//     Nothing here writes a Blob, a MediaRecorder, or a file. We keep the
//     transcript; the audio does not outlive the request that carried it.
//
// No voiceprints, no speaker embeddings, no emotion/tone inference — this
// module produces raw samples and a loudness number, and nothing else.

import {
  TARGET_SAMPLE_RATE,
  DEFAULT_SILENCE_RMS,
  floatToS16,
  resampleLinear,
  rmsS16,
  s16ToBytes,
} from './pcm';

/**
 * Worklet processor source. Inlined and loaded from a Blob URL so consumers do
 * not have to publish a separate asset and configure their bundler to emit it —
 * a library that needs a build-tool change to work is a library that gets
 * hand-rolled instead.
 *
 * The processor does the minimum: accumulate input quanta until it has
 * `chunkFrames`, post a copy, repeat. All conversion happens on the main
 * thread where it is testable.
 */
const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this._chunkFrames = opts.chunkFrames || 3200;
    this._buf = new Float32Array(this._chunkFrames);
    this._filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const room = this._chunkFrames - this._filled;
      const take = Math.min(room, channel.length - offset);
      this._buf.set(channel.subarray(offset, offset + take), this._filled);
      this._filled += take;
      offset += take;
      if (this._filled === this._chunkFrames) {
        this.port.postMessage(this._buf.slice(0));
        this._filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('rm-voice-capture', CaptureProcessor);
`;

export interface PcmChunk {
  /** s16le mono bytes at TARGET_SAMPLE_RATE, ready to POST. */
  bytes: Uint8Array;
  /** Duration this chunk represents. */
  durationMs: number;
  /** RMS in s16 amplitude units. */
  rms: number;
  /** Whether the client's gate scored this chunk as speech. */
  isSpeech: boolean;
}

export interface PcmRecorderOptions {
  /** Audio per POST. 200 ms matches what the call-path tap sends. */
  chunkMs?: number;
  /** RMS gate, in s16 amplitude units. Mirrors the sidecar's LIVE_SILENCE_RMS. */
  silenceRms?: number;
  /** Called for every chunk. Must not throw — it is invoked from an audio callback. */
  onChunk: (chunk: PcmChunk) => void;
  /** Fatal capture error (permission denied, no device, worklet unavailable). */
  onError?: (err: Error) => void;
}

/** True when this browser can do ambient capture at all. */
export function isVoiceCaptureSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioContext !== 'undefined' &&
    // Blob-URL worklet loading needs both of these.
    typeof Blob !== 'undefined' &&
    typeof URL?.createObjectURL === 'function' &&
    // SubtleCrypto for the channel hash — secure-context only, same as gUM.
    !!globalThis.crypto?.subtle
  );
}

export class PcmRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private workletUrl: string | null = null;
  private readonly opts: Required<Omit<PcmRecorderOptions, 'onError'>> &
    Pick<PcmRecorderOptions, 'onError'>;

  constructor(opts: PcmRecorderOptions) {
    this.opts = {
      chunkMs: opts.chunkMs ?? 200,
      silenceRms: opts.silenceRms ?? DEFAULT_SILENCE_RMS,
      onChunk: opts.onChunk,
      ...(opts.onError ? { onError: opts.onError } : {}),
    };
  }

  /** True only while a real MediaStreamTrack is live. Drives the UI indicator. */
  get micActive(): boolean {
    return (this.stream?.getAudioTracks() ?? []).some((t) => t.readyState === 'live');
  }

  async start(): Promise<void> {
    if (this.stream) return;
    // Ask for the mic FIRST. If this rejects nothing else was allocated.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    this.stream = stream;

    try {
      // Ask the browser's own resampler for 16 kHz. Chrome and Firefox honour
      // this; Safari has historically handed back the hardware rate instead, so
      // the actual ctx.sampleRate is re-checked per chunk below.
      const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      this.ctx = ctx;
      if (ctx.state === 'suspended') await ctx.resume();

      const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
      this.workletUrl = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(this.workletUrl);

      const chunkFrames = Math.max(
        128,
        Math.round((this.opts.chunkMs / 1000) * ctx.sampleRate),
      );
      const node = new AudioWorkletNode(ctx, 'rm-voice-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { chunkFrames },
      });
      node.port.onmessage = (ev: MessageEvent) => {
        try {
          this.emit(ev.data as Float32Array, ctx.sampleRate);
        } catch (err) {
          this.opts.onError?.(err as Error);
        }
      };
      this.node = node;
      this.source = ctx.createMediaStreamSource(stream);
      this.source.connect(node);
      // Deliberately NOT connected to ctx.destination — routing the mic to the
      // speakers is a feedback loop, and there is nothing to monitor.
    } catch (err) {
      // Anything after gUM failing must still release the track, or the
      // recording indicator stays lit with no UI attached to it.
      this.stop();
      throw err;
    }
  }

  private emit(samples: Float32Array, ctxRate: number): void {
    const at16k =
      ctxRate === TARGET_SAMPLE_RATE
        ? samples
        : resampleLinear(samples, ctxRate, TARGET_SAMPLE_RATE);
    const s16 = floatToS16(at16k);
    const rms = rmsS16(s16);
    this.opts.onChunk({
      bytes: s16ToBytes(s16),
      durationMs: (s16.length / TARGET_SAMPLE_RATE) * 1000,
      rms,
      isSpeech: rms >= this.opts.silenceRms,
    });
  }

  /**
   * Release everything. Idempotent, never throws, and safe to call from a
   * cleanup path — the track MUST come down even if teardown of the graph
   * fails partway.
   */
  stop(): void {
    try {
      if (this.node) this.node.port.onmessage = null;
      this.source?.disconnect();
      this.node?.disconnect();
    } catch {
      /* graph already torn down */
    }
    // The track release is the privacy-relevant step; do it unconditionally
    // and before anything that could still throw.
    for (const track of this.stream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        /* already ended */
      }
    }
    this.stream = null;
    this.source = null;
    this.node = null;
    const ctx = this.ctx;
    this.ctx = null;
    try {
      void ctx?.close();
    } catch {
      /* already closed */
    }
    if (this.workletUrl) {
      try {
        URL.revokeObjectURL(this.workletUrl);
      } catch {
        /* noop */
      }
      this.workletUrl = null;
    }
  }
}
