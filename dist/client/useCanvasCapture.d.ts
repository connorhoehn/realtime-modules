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
export declare function useCanvasCapture(options: UseCanvasCaptureOptions): UseCanvasCaptureReturn;
//# sourceMappingURL=useCanvasCapture.d.ts.map