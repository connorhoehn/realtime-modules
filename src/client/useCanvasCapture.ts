// realtime-modules/src/client/useCanvasCapture.ts
//
// Turns a <canvas> the page already owns into a live MediaStreamTrack.
//
// ---------------------------------------------------------------------------
// Why this is not screen capture — and why that is the better answer
// ---------------------------------------------------------------------------
// `getDisplayMedia` cannot be called without a user gesture and always shows
// the browser's own source picker. There is no way around that and there
// should not be: silently capturing someone's screen is exactly the thing that
// permission gate exists to prevent.
//
// But when the thing you want to record is a canvas the page itself is
// painting — a diagram, a chart, a game board — you do not need the screen at
// all. `HTMLCanvasElement.captureStream()` yields a real MediaStreamTrack with
// NO permission prompt, because the page is capturing its own output rather
// than the user's desktop. The resulting track publishes through any normal
// media path.
//
// ---------------------------------------------------------------------------
// Why it re-paints into an offscreen canvas instead of capturing directly
// ---------------------------------------------------------------------------
// `captureStream(fps)` on a source canvas only produces a frame when that
// canvas is actually painted. A diagram is static most of the time, so a
// direct capture emits a burst of frames during a drag and then nothing for
// minutes. Some encoders and most recorders treat that as a stalled source.
//
// Mirroring into our own canvas on a fixed interval gives a steady, honest
// frame rate. It also gives a compositing surface: pass more than one source
// and they are drawn in order, which is how you capture a scene layer plus its
// cursor/overlay layer as a single track.
//
// ---------------------------------------------------------------------------
// Frame rate
// ---------------------------------------------------------------------------
// A diagram is not video. The default of 5 fps is chosen because the content
// changes in discrete edits rather than continuously, and because every video
// encoder in the path drops duplicate frames anyway — pushing 30 fps of an
// unchanged whiteboard buys nothing and costs CPU on every subscriber. Raise
// it only if you are capturing something genuinely animated.

import { useEffect, useRef, useState } from 'react';

export interface UseCanvasCaptureOptions {
    /**
     * Source canvases, drawn in order onto the capture surface. Later entries
     * paint on top — pass `[scene, overlay]` to composite a cursor layer.
     *
     * A function is accepted so callers can resolve elements that mount later
     * (a lazily-loaded editor, say) without re-running the effect.
     */
    sources: () => Array<HTMLCanvasElement | null | undefined>;
    /** Frames per second. Default 5 — see the note above. */
    fps?: number;
    /** Start capturing. Flipping to false stops and releases the track. */
    enabled: boolean;
    /**
     * Capture surface size. Defaults to the first source's intrinsic size,
     * re-read on every frame so a resize is followed automatically.
     */
    width?: number;
    height?: number;
}

export interface UseCanvasCaptureReturn {
    /** Live video track, or null when not capturing. */
    track: MediaStreamTrack | null;
    /** The stream the track belongs to — convenient for a local <video> preview. */
    stream: MediaStream | null;
    /** True while a track is live. Mirrors the track, never a separate flag. */
    capturing: boolean;
    /** Why capture could not start, if it could not. */
    error: string | null;
}

const DEFAULT_FPS = 5;

export function useCanvasCapture(
    options: UseCanvasCaptureOptions,
): UseCanvasCaptureReturn {
    const { sources, fps = DEFAULT_FPS, enabled, width, height } = options;

    const [stream, setStream] = useState<MediaStream | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Kept in a ref so changing the resolver never restarts a live capture.
    const sourcesRef = useRef(sources);
    sourcesRef.current = sources;

    useEffect(() => {
        if (!enabled) {
            setError(null);
            return;
        }
        if (typeof document === 'undefined') return;

        const surface = document.createElement('canvas');
        const ctx = surface.getContext('2d');
        if (!ctx) {
            setError('2D canvas context unavailable — cannot capture.');
            return;
        }

        const captureStream = (
            surface as HTMLCanvasElement & {
                captureStream?: (frameRate?: number) => MediaStream;
            }
        ).captureStream;
        if (typeof captureStream !== 'function') {
            setError('This browser does not support canvas.captureStream().');
            return;
        }

        // Size before the first capture so the track's resolution is stable —
        // resizing a canvas mid-capture renegotiates in some browsers.
        const first = sourcesRef.current().find(Boolean);
        surface.width = width ?? first?.width ?? 1280;
        surface.height = height ?? first?.height ?? 720;

        const captured = captureStream.call(surface, fps);
        const videoTrack = captured.getVideoTracks()[0] ?? null;
        if (!videoTrack) {
            setError('captureStream() produced no video track.');
            return;
        }

        const paint = () => {
            // Clearing first matters: sources may have transparent regions and
            // without a clear the previous frame shows through as smearing.
            ctx.clearRect(0, 0, surface.width, surface.height);
            for (const src of sourcesRef.current()) {
                if (!src || src.width === 0 || src.height === 0) continue;
                try {
                    ctx.drawImage(src, 0, 0, surface.width, surface.height);
                } catch {
                    // A tainted or detached source must not kill the capture
                    // loop — skip the layer and keep the track alive.
                }
            }
        };

        paint();
        const interval = setInterval(paint, Math.max(1000 / fps, 16));
        setStream(captured);
        setError(null);

        return () => {
            clearInterval(interval);
            // Stop every track, not just the video one, so the browser's
            // capture indicator can never disagree with our UI.
            for (const t of captured.getTracks()) t.stop();
            setStream(null);
        };
    }, [enabled, fps, width, height]);

    const track = stream?.getVideoTracks()[0] ?? null;

    // `capturing` is derived from the track's own readyState rather than a
    // separate boolean. A UI that says "off" while a track is live is the
    // failure mode this deliberately makes impossible.
    const capturing = track !== null && track.readyState === 'live';

    return { track, stream, capturing, error };
}
