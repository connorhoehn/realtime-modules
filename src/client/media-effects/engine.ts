// realtime-modules/src/client/media-effects/engine.ts
//
// MediaEffectsEngine — the non-React core of the media-effects subpath.
//
// The reference implementation (videonowandlater's useFilterPipeline) built
// a canvas pipeline the moment a stream was wrapped, even with every effect
// off — burning a RAF loop + captureStream on people who never touch a
// filter. This engine is LAZY instead:
//
//   - While inactive (filter 'none', background 'none', no sprite) there is
//     NO canvas, NO RAF loop, and getOutputTrack() returns the raw source
//     track — identity passthrough, zero cost.
//   - On the inactive→active edge the pipeline is built (hidden <video>
//     playing the source track, output/bg/person canvases allocated once,
//     RAF draw loop, canvas.captureStream(30)) and the output becomes the
//     canvas track. On the active→inactive edge it is torn down and the
//     output reverts to the raw track.
//   - Setting changes while active are plain field reads in the draw loop —
//     no rebuild, no output identity change, so downstream consumers
//     (RTCRtpSender.replaceTrack etc.) only hear from onOutputChange when
//     the track identity actually changes.
//
// Every DOM/global construction goes through small protected factory
// methods so unit tests can subclass the engine and exercise the state
// machine without jsdom, canvas, or MediaPipe.
//
// Ownership: the engine NEVER stops the source track — the caller acquired
// it (getUserMedia) and owns its lifecycle. Only pipeline-created canvas
// tracks are stopped on teardown.

import { getFilterById } from './presets';
import { PersonSegmenter, warmupSegmenter } from './segmenter';
import { FaceTracker, warmupFaceLandmarker } from './faceLandmarker';
import { getSpriteById } from './faceSprites';

export type BackgroundMode = 'none' | 'blur' | 'image';

export type OutputChangeListener = (track: MediaStreamTrack | null) => void;

export type WarmupTarget = 'segmentation' | 'faces' | 'all';

/**
 * Temporal smoothing weight for the segmentation mask. Each fresh mask is
 * composited into maskSmoothCanvas at this alpha over the previous smoothed
 * contents — an exponential moving average that suppresses the per-frame
 * contour flicker users reported as "choppy". Range (0, 1]: higher = more
 * responsive, lower = smoother.
 */
export const MASK_EMA_ALPHA = 0.45;

/**
 * Feather radius (px) applied when the smoothed mask cuts out the person
 * (`destination-in` draw). Softens the silhouette edge so it isn't
 * hard/blocky against the blurred or replaced background.
 */
export const MASK_FEATHER_PX = 3;

/**
 * Run person segmentation every Nth drawn frame; the in-between frames
 * reuse the smoothed mask (the EMA makes the reuse invisible). Segmentation
 * is the dominant per-frame CPU cost, and halving its rate removes most of
 * the jitter. The FaceLandmarker still runs every frame — sprite tracking
 * must not lag the face.
 */
export const SEGMENT_FRAME_INTERVAL = 2;

interface Pipeline {
  video: HTMLVideoElement;
  outputCanvas: HTMLCanvasElement;
  bgCanvas: HTMLCanvasElement;
  personCanvas: HTMLCanvasElement;
  /** EMA accumulator for the segmentation mask (see MASK_EMA_ALPHA). */
  maskSmoothCanvas: HTMLCanvasElement;
  /** True once maskSmoothCanvas holds a seeded mask (reset on resize). */
  maskSeeded: boolean;
  /** Most recent raw mask — fallback when the smooth canvas has no 2d ctx. */
  lastMask: HTMLCanvasElement | null;
  /** Drawn-frame counter driving SEGMENT_FRAME_INTERVAL pacing. */
  frameIndex: number;
  outputCtx: CanvasRenderingContext2D | null;
  rafId: number;
  stream: MediaStream | null;
  outputTrack: MediaStreamTrack | null;
  segmenter: PersonSegmenter;
  faceTracker: FaceTracker;
  startTimeMs: number;
}

export class MediaEffectsEngine {
  private source: MediaStreamTrack | null = null;
  private filterId = 'none';
  private backgroundMode: BackgroundMode = 'none';
  private backgroundImageUrl: string | null = null;
  private backgroundImage: HTMLImageElement | null = null;
  private faceSpriteId: string | null = null;
  private pipeline: Pipeline | null = null;
  private listeners = new Set<OutputChangeListener>();
  private disposed = false;

  // Bound once so add/removeEventListener pair correctly across setSource calls.
  private handleSourceEnded = () => {
    // A dead camera track can't feed the pipeline; tear down and tell
    // consumers the output is gone rather than freezing on the last frame.
    const prev = this.getOutputTrack();
    this.teardownPipeline();
    if (this.source) {
      this.source.removeEventListener?.('ended', this.handleSourceEnded);
    }
    this.source = null;
    this.emitIfChanged(prev);
  };

  // ---------------------------------------------------------------- state

  getFilterId(): string { return this.filterId; }
  getBackgroundMode(): BackgroundMode { return this.backgroundMode; }
  getBackgroundImageUrl(): string | null { return this.backgroundImageUrl; }
  getFaceSpriteId(): string | null { return this.faceSpriteId; }
  getSource(): MediaStreamTrack | null { return this.source; }

  /** Active = at least one effect is on. Drives pipeline existence. */
  isActive(): boolean {
    return this.filterId !== 'none' || this.backgroundMode !== 'none' || this.faceSpriteId != null;
  }

  /** Canvas track while active, raw source track while inactive. */
  getOutputTrack(): MediaStreamTrack | null {
    return this.pipeline?.outputTrack ?? this.source;
  }

  /** Fired whenever output identity changes (activation, deactivation,
   *  setSource, source ended). Returns unsubscribe. */
  onOutputChange(cb: OutputChangeListener): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  // -------------------------------------------------------------- source

  setSource(track: MediaStreamTrack | null): void {
    if (track === this.source) return;
    const prev = this.getOutputTrack();
    if (this.source) {
      this.source.removeEventListener?.('ended', this.handleSourceEnded);
    }
    // A pipeline is bound to its <video> element's stream, so a new source
    // means rebuild (fresh capture), not repoint.
    this.teardownPipeline();
    this.source = track;
    if (track && !this.disposed) {
      track.addEventListener?.('ended', this.handleSourceEnded);
      if (this.isActive()) this.buildPipeline();
    }
    this.emitIfChanged(prev);
  }

  // ------------------------------------------------------------- setters

  setFilter(id: string): void {
    if (id === this.filterId) return;
    const prev = this.getOutputTrack();
    this.filterId = id;
    this.syncPipeline();
    this.emitIfChanged(prev);
  }

  setBackgroundMode(mode: BackgroundMode): void {
    if (mode === this.backgroundMode) return;
    const prev = this.getOutputTrack();
    this.backgroundMode = mode;
    this.syncPipeline();
    if (mode === 'blur' || mode === 'image') {
      // Kick the ~3 MB model download now so the first composited frame
      // isn't preceded by seconds of un-blurred passthrough.
      this.pipeline?.segmenter.warmup();
    }
    this.emitIfChanged(prev);
  }

  setBackgroundImageUrl(url: string | null): void {
    this.backgroundImageUrl = url;
    if (!url) {
      this.backgroundImage = null;
      return;
    }
    this.loadBackgroundImage(url, (img) => {
      // Ignore stale loads: only latch if this is still the wanted url.
      if (this.backgroundImageUrl === url) this.backgroundImage = img;
    });
  }

  setFaceSpriteId(id: string | null): void {
    if (id === this.faceSpriteId) return;
    const prev = this.getOutputTrack();
    this.faceSpriteId = id;
    this.syncPipeline();
    if (id) {
      // Same rationale as segmenter warmup: fetch the landmark model early.
      this.pipeline?.faceTracker.warmup();
    }
    this.emitIfChanged(prev);
  }

  // ------------------------------------------------------------ lifecycle

  /** Full teardown. Never stops the source track (caller owns it). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardownPipeline();
    if (this.source) {
      this.source.removeEventListener?.('ended', this.handleSourceEnded);
      this.source = null;
    }
    this.listeners.clear();
  }

  // ----------------------------------------------- pipeline state machine

  private syncPipeline(): void {
    const shouldRun = this.isActive() && !!this.source && !this.disposed;
    if (shouldRun && !this.pipeline) {
      this.buildPipeline();
    } else if (!shouldRun && this.pipeline) {
      this.teardownPipeline();
    }
  }

  private buildPipeline(): void {
    const track = this.source;
    if (!track || this.pipeline) return;

    const settings = track.getSettings?.() ?? {};
    const width = settings.width ?? 1280;
    const height = settings.height ?? 720;

    const video = this.createVideoElement(track);
    const outputCanvas = this.createCanvas(width, height);
    // Auxiliary canvases for the background pipeline. Allocated up front so
    // we don't churn on every frame; sizes re-synced in the draw loop when
    // the track's real dimensions differ (rotation, constraint changes).
    const bgCanvas = this.createCanvas(width, height);
    const personCanvas = this.createCanvas(width, height);
    const maskSmoothCanvas = this.createCanvas(width, height);
    const outputCtx = outputCanvas.getContext?.('2d') ?? null;

    const stream = this.captureCanvasStream(outputCanvas);
    const outputTrack = stream?.getVideoTracks?.()[0] ?? null;

    const pipeline: Pipeline = {
      video,
      outputCanvas,
      bgCanvas,
      personCanvas,
      maskSmoothCanvas,
      maskSeeded: false,
      lastMask: null,
      frameIndex: 0,
      outputCtx,
      rafId: 0,
      stream,
      outputTrack,
      segmenter: this.createSegmenter(),
      faceTracker: this.createFaceTracker(),
      startTimeMs: this.now(),
    };
    this.pipeline = pipeline;

    const loop = () => {
      // Schedule first so a draw exception can't kill the loop permanently.
      pipeline.rafId = this.requestFrame(loop);
      try {
        this.drawFrame(pipeline);
      } catch {
        // A single bad frame (MediaPipe hiccup, detached context) is
        // dropped; the next frame retries.
      }
    };
    pipeline.rafId = this.requestFrame(loop);
  }

  private teardownPipeline(): void {
    const p = this.pipeline;
    if (!p) return;
    this.pipeline = null;
    this.cancelFrame(p.rafId);
    try { p.video.pause?.(); } catch { /* detached element */ }
    try { (p.video as { srcObject: unknown }).srcObject = null; } catch { /* ignore */ }
    try { p.segmenter.close(); } catch { /* ignore */ }
    try { p.faceTracker.close(); } catch { /* ignore */ }
    // Stop only pipeline-created (canvas capture) tracks — never the source.
    if (p.stream) {
      for (const t of p.stream.getTracks?.() ?? []) {
        if (t !== this.source) {
          try { t.stop(); } catch { /* already stopped */ }
        }
      }
    }
  }

  // ------------------------------------------------------------ draw loop

  private drawFrame(p: Pipeline): void {
    const { video, outputCanvas, bgCanvas, personCanvas, outputCtx } = p;
    if (!outputCtx) return;
    if ((video.readyState ?? 0) < 2) return;

    // Dimension sync: the reference claimed to handle track resizes but
    // never did. Rotation / applyConstraints can change videoWidth/Height
    // mid-stream; resize all canvases together or the composite smears.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw && vh && (outputCanvas.width !== vw || outputCanvas.height !== vh)) {
      outputCanvas.width = bgCanvas.width = personCanvas.width = p.maskSmoothCanvas.width = vw;
      outputCanvas.height = bgCanvas.height = personCanvas.height = p.maskSmoothCanvas.height = vh;
      // Resizing wipes the smooth canvas; re-seed from the next fresh mask
      // (alpha 1) instead of EMA-fading in from transparent.
      p.maskSeeded = false;
      p.lastMask = null;
    }

    const w = outputCanvas.width;
    const h = outputCanvas.height;
    const cssFilter = getFilterById(this.filterId).cssFilter;
    const bgMode = this.backgroundMode;

    let composited = false;
    if (bgMode === 'blur' || bgMode === 'image') {
      const ts = this.now() - p.startTimeMs;

      // Frame pacing: segmentForVideo is the dominant CPU cost, so run it
      // only every SEGMENT_FRAME_INTERVAL-th drawn frame once a mask
      // exists; skipped frames reuse the smoothed mask (the EMA makes the
      // reuse invisible). Until the first mask lands (model still loading)
      // we try every frame so the effect starts as soon as possible.
      const tick = p.frameIndex++;
      const due = tick % this.segmentFrameInterval() === 0;
      if (due || !p.lastMask) {
        let fresh: HTMLCanvasElement | null = null;
        try {
          fresh = p.segmenter.segment(video, ts);
        } catch {
          // Failed segmentation frame → reuse the previous mask (or fall
          // back to a plain filtered draw if we never had one).
          fresh = null;
        }
        if (fresh) {
          p.lastMask = fresh;
          this.blendMaskIntoSmooth(p, fresh, w, h);
        }
      }

      // Prefer the temporally-smoothed mask; fall back to the raw mask
      // when the smooth canvas has no usable 2d context.
      const maskCanvas = p.maskSeeded ? p.maskSmoothCanvas : p.lastMask;

      if (maskCanvas) {
        // Background layer: blurred frame or a user-chosen cover-fit image.
        const bgCtx = bgCanvas.getContext('2d');
        if (bgCtx) {
          if (bgMode === 'image' && this.backgroundImage) {
            const img = this.backgroundImage;
            const s = Math.max(w / img.width, h / img.height);
            const dw = img.width * s;
            const dh = img.height * s;
            bgCtx.filter = 'none';
            bgCtx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
          } else {
            bgCtx.filter = 'blur(14px)';
            bgCtx.drawImage(video, 0, 0, w, h);
            bgCtx.filter = 'none';
          }
        }

        // Person cutout: filtered frame masked to person silhouette.
        const personCtx = personCanvas.getContext('2d');
        if (personCtx) {
          personCtx.globalCompositeOperation = 'source-over';
          personCtx.filter = cssFilter;
          personCtx.drawImage(video, 0, 0, w, h);
          personCtx.filter = 'none';
          // Feathered cutout: blurring the (smoothed) mask at draw time
          // softens the silhouette edge instead of leaving it hard/blocky.
          personCtx.globalCompositeOperation = 'destination-in';
          personCtx.filter = `blur(${MASK_FEATHER_PX}px)`;
          personCtx.drawImage(maskCanvas, 0, 0, w, h);
          personCtx.filter = 'none';
          personCtx.globalCompositeOperation = 'source-over';
        }

        outputCtx.filter = 'none';
        outputCtx.drawImage(bgCanvas, 0, 0, w, h);
        outputCtx.drawImage(personCanvas, 0, 0, w, h);
        composited = true;
      }
    }

    if (!composited) {
      outputCtx.filter = cssFilter;
      outputCtx.drawImage(video, 0, 0, w, h);
    }

    // Face sprites — rendered last, on top of everything else. Runs only
    // when a sprite is selected so the Landmarker isn't invoked for users
    // who don't touch the feature.
    const spriteId = this.faceSpriteId;
    if (spriteId) {
      const sprite = getSpriteById(spriteId);
      if (sprite) {
        try {
          const ts = this.now() - p.startTimeMs;
          const landmarks = p.faceTracker.detect(video, ts);
          if (landmarks) {
            outputCtx.filter = 'none';
            sprite.render(outputCtx, landmarks, w, h);
          }
        } catch {
          // Sprite failures never take down the composited frame.
        }
      }
    }
  }

  /**
   * Composite a fresh segmentation mask into the EMA accumulator.
   *
   * First mask after build/resize seeds the canvas with a full-alpha copy
   * so effects don't fade in from nothing. After that each fresh mask is
   * blended at MASK_EMA_ALPHA: previous contents are first faded by
   * (1 - alpha) via a destination-out fill, then the new mask is drawn
   * source-over at alpha. The pre-fade matters — a bare source-over at
   * partial alpha can only ever *raise* per-pixel alpha, which would leave
   * permanent ghost silhouettes wherever the person used to be.
   */
  private blendMaskIntoSmooth(p: Pipeline, mask: HTMLCanvasElement, w: number, h: number): void {
    const ctx = p.maskSmoothCanvas.getContext?.('2d') ?? null;
    if (!ctx) return;
    if (!p.maskSeeded) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(mask, 0, 0, w, h);
      p.maskSeeded = true;
      return;
    }
    ctx.globalAlpha = MASK_EMA_ALPHA;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(mask, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------- warmup

  /**
   * Preload MediaPipe models before any effect is selected — call when the
   * effects UI opens so the first toggle doesn't freeze on model init.
   * Fire-and-forget, safe to call repeatedly (keyed singleton loaders),
   * SSR-safe (no-op without window/document), and works before any
   * pipeline exists (module-level loaders, not pipeline instances).
   */
  warmup(target: WarmupTarget = 'all'): void {
    if (target === 'segmentation' || target === 'all') {
      void this.warmupSegmentation();
    }
    if (target === 'faces' || target === 'all') {
      void this.warmupFaces();
    }
  }

  // ------------------------------------------------------------ listeners

  private emitIfChanged(prev: MediaStreamTrack | null): void {
    const next = this.getOutputTrack();
    if (next === prev) return;
    for (const cb of [...this.listeners]) {
      try { cb(next); } catch { /* listener errors are theirs */ }
    }
  }

  // ------------------------------------------------------------ factories
  //
  // All DOM/global construction is funneled through these so tests can
  // subclass and stub them — the state machine above is then exercisable
  // in plain node with fake tracks/canvases.

  protected createVideoElement(track: MediaStreamTrack): HTMLVideoElement {
    const video = document.createElement('video');
    video.srcObject = new MediaStream([track]);
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    void video.play().catch(() => { /* autoplay policies */ });
    return video;
  }

  protected createCanvas(width: number, height: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  protected captureCanvasStream(canvas: HTMLCanvasElement): MediaStream | null {
    // Some environments (older Safari embeds, headless) lack captureStream;
    // without it we keep the raw track as output rather than going dark.
    if (typeof canvas.captureStream !== 'function') return null;
    return canvas.captureStream(30);
  }

  protected createSegmenter(): PersonSegmenter {
    return new PersonSegmenter();
  }

  /** Segmentation pacing divisor; overridable in tests. */
  protected segmentFrameInterval(): number {
    return SEGMENT_FRAME_INTERVAL;
  }

  /** Module-level segmenter loader trigger; overridable in tests. */
  protected warmupSegmentation(): Promise<void> {
    return warmupSegmenter();
  }

  /** Module-level face-landmarker loader trigger; overridable in tests. */
  protected warmupFaces(): Promise<void> {
    return warmupFaceLandmarker();
  }

  protected createFaceTracker(): FaceTracker {
    return new FaceTracker();
  }

  protected loadBackgroundImage(url: string, onLoad: (img: HTMLImageElement) => void): void {
    if (typeof Image === 'undefined') return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => onLoad(img);
    img.src = url;
  }

  protected requestFrame(cb: FrameRequestCallback): number {
    return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : 0;
  }

  protected cancelFrame(id: number): void {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  }

  protected now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }
}
