// realtime-modules/test/client/media-effects/engine.test.ts
//
// MediaEffectsEngine activation state machine, exercised WITHOUT jsdom,
// canvas, or MediaPipe: the engine funnels all DOM/global construction
// through protected factory methods, so a subclass with fakes lets these
// tests pin the load-bearing contract —
//   - inactive = identity passthrough (no canvas, no RAF, raw track out)
//   - inactive→active edge builds the pipeline and swaps output identity
//   - active→inactive edge tears down and reverts to the raw track
//   - setting flips while active never churn output identity
//   - the source track is NEVER stopped by the engine (caller owns it)

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  MediaEffectsEngine,
  MASK_EMA_ALPHA,
  MASK_FEATHER_PX,
  SEGMENT_FRAME_INTERVAL,
} from '../../../src/client/media-effects/engine';
import { warmupSegmenter } from '../../../src/client/media-effects/segmenter';
import type { PersonSegmenter } from '../../../src/client/media-effects/segmenter';
import { warmupFaceLandmarker } from '../../../src/client/media-effects/faceLandmarker';
import type { FaceTracker } from '../../../src/client/media-effects/faceLandmarker';

class FakeTrack {
  kind = 'video';
  stop = jest.fn();
  private listeners = new Map<string, Set<() => void>>();

  addEventListener = jest.fn((type: string, cb: () => void) => {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  });

  removeEventListener = jest.fn((type: string, cb: () => void) => {
    this.listeners.get(type)?.delete(cb);
  });

  getSettings() {
    return { width: 640, height: 480 };
  }

  fireEnded() {
    for (const cb of [...(this.listeners.get('ended') ?? [])]) cb();
  }

  asTrack(): MediaStreamTrack {
    return this as unknown as MediaStreamTrack;
  }
}

interface FakeSegmenter {
  warmup: jest.Mock;
  close: jest.Mock;
  segment: jest.Mock;
}

interface FakeFaceTracker {
  warmup: jest.Mock;
  close: jest.Mock;
  detect: jest.Mock;
}

class TestEngine extends MediaEffectsEngine {
  canvasesCreated = 0;
  framesRequested = 0;
  canvasTracks: FakeTrack[] = [];
  segmenters: FakeSegmenter[] = [];
  faceTrackers: FakeFaceTracker[] = [];

  protected override createVideoElement(_track: MediaStreamTrack): HTMLVideoElement {
    return {
      readyState: 0,
      videoWidth: 0,
      videoHeight: 0,
      pause: jest.fn(),
      srcObject: null,
    } as unknown as HTMLVideoElement;
  }

  protected override createCanvas(width: number, height: number): HTMLCanvasElement {
    this.canvasesCreated++;
    return { width, height, getContext: () => null } as unknown as HTMLCanvasElement;
  }

  protected override captureCanvasStream(_canvas: HTMLCanvasElement): MediaStream | null {
    const track = new FakeTrack();
    this.canvasTracks.push(track);
    return {
      getVideoTracks: () => [track.asTrack()],
      getTracks: () => [track.asTrack()],
    } as unknown as MediaStream;
  }

  protected override createSegmenter(): PersonSegmenter {
    const seg: FakeSegmenter = { warmup: jest.fn(), close: jest.fn(), segment: jest.fn(() => null) };
    this.segmenters.push(seg);
    return seg as unknown as PersonSegmenter;
  }

  protected override createFaceTracker(): FaceTracker {
    const ft: FakeFaceTracker = { warmup: jest.fn(), close: jest.fn(), detect: jest.fn(() => null) };
    this.faceTrackers.push(ft);
    return ft as unknown as FaceTracker;
  }

  protected override loadBackgroundImage(): void { /* no-op in tests */ }

  protected override requestFrame(_cb: FrameRequestCallback): number {
    this.framesRequested++;
    return this.framesRequested;
  }

  protected override cancelFrame(): void { /* no-op */ }

  protected override now(): number { return 0; }
}

describe('MediaEffectsEngine state machine', () => {
  let engine: TestEngine;
  let raw: FakeTrack;
  let outputs: Array<MediaStreamTrack | null>;

  beforeEach(() => {
    engine = new TestEngine();
    raw = new FakeTrack();
    outputs = [];
    engine.onOutputChange((t) => outputs.push(t));
  });

  it('is identity passthrough while inactive: raw track out, zero pipeline cost', () => {
    engine.setSource(raw.asTrack());
    expect(engine.isActive()).toBe(false);
    expect(engine.getOutputTrack()).toBe(raw.asTrack());
    expect(engine.canvasesCreated).toBe(0);
    expect(engine.framesRequested).toBe(0);
    // attach itself is an output change (null → raw)
    expect(outputs).toEqual([raw.asTrack()]);
  });

  it('builds the pipeline on the inactive→active edge and emits the canvas track', () => {
    engine.setSource(raw.asTrack());
    engine.setFilter('warm');

    expect(engine.isActive()).toBe(true);
    expect(engine.canvasesCreated).toBe(4); // output + bg + person + maskSmooth
    expect(engine.framesRequested).toBeGreaterThan(0);
    const canvasTrack = engine.canvasTracks[0].asTrack();
    expect(engine.getOutputTrack()).toBe(canvasTrack);
    expect(outputs[outputs.length - 1]).toBe(canvasTrack);
  });

  it('keeps output identity stable across setting changes while active', () => {
    engine.setSource(raw.asTrack());
    engine.setFilter('warm');
    const emissions = outputs.length;
    const out = engine.getOutputTrack();

    engine.setFilter('sepia');
    engine.setFaceSpriteId('crown'); // still active — no rebuild

    expect(engine.getOutputTrack()).toBe(out);
    expect(outputs.length).toBe(emissions);
    expect(engine.canvasesCreated).toBe(4); // no second pipeline
  });

  it('tears down and reverts to raw on the active→inactive edge', () => {
    engine.setSource(raw.asTrack());
    engine.setFilter('warm');
    engine.setFilter('none');

    expect(engine.isActive()).toBe(false);
    expect(engine.getOutputTrack()).toBe(raw.asTrack());
    expect(outputs[outputs.length - 1]).toBe(raw.asTrack());
    // Pipeline resources released; source untouched.
    expect(engine.canvasTracks[0].stop).toHaveBeenCalled();
    expect(engine.segmenters[0].close).toHaveBeenCalled();
    expect(engine.faceTrackers[0].close).toHaveBeenCalled();
    expect(raw.stop).not.toHaveBeenCalled();
  });

  it('rebuilds the pipeline when the source changes while active', () => {
    engine.setSource(raw.asTrack());
    engine.setFilter('warm');
    const firstOut = engine.getOutputTrack();

    const raw2 = new FakeTrack();
    engine.setSource(raw2.asTrack());

    expect(engine.canvasTracks).toHaveLength(2);
    const secondOut = engine.getOutputTrack();
    expect(secondOut).toBe(engine.canvasTracks[1].asTrack());
    expect(secondOut).not.toBe(firstOut);
    expect(outputs[outputs.length - 1]).toBe(secondOut);
    // Old pipeline torn down, neither raw track stopped.
    expect(engine.canvasTracks[0].stop).toHaveBeenCalled();
    expect(raw.stop).not.toHaveBeenCalled();
    expect(raw2.stop).not.toHaveBeenCalled();
    // ended listener moved to the new source
    expect(raw.removeEventListener).toHaveBeenCalled();
    expect(raw2.addEventListener).toHaveBeenCalled();
  });

  it('tears down and emits null when the source track ends', () => {
    engine.setSource(raw.asTrack());
    engine.setFilter('warm');

    raw.fireEnded();

    expect(engine.getOutputTrack()).toBeNull();
    expect(outputs[outputs.length - 1]).toBeNull();
    expect(engine.canvasTracks[0].stop).toHaveBeenCalled();
    expect(raw.stop).not.toHaveBeenCalled();
  });

  it('dispose() releases the pipeline but never stops the source track', () => {
    engine.setSource(raw.asTrack());
    engine.setBackgroundMode('blur');
    engine.dispose();

    expect(engine.canvasTracks[0].stop).toHaveBeenCalled();
    expect(engine.segmenters[0].close).toHaveBeenCalled();
    expect(raw.stop).not.toHaveBeenCalled();
    expect(raw.removeEventListener).toHaveBeenCalled();
  });

  it('warms up the segmenter for background modes and the tracker for sprites', () => {
    engine.setSource(raw.asTrack());
    engine.setBackgroundMode('blur');
    expect(engine.segmenters[0].warmup).toHaveBeenCalled();

    engine.setFaceSpriteId('crown');
    expect(engine.faceTrackers[0].warmup).toHaveBeenCalled();
  });

  it('activation before a source exists builds nothing until setSource', () => {
    engine.setFilter('noir');
    expect(engine.canvasesCreated).toBe(0);
    expect(engine.getOutputTrack()).toBeNull();

    engine.setSource(raw.asTrack());
    expect(engine.canvasesCreated).toBe(4);
    expect(engine.getOutputTrack()).toBe(engine.canvasTracks[0].asTrack());
  });

  it('onOutputChange unsubscribe stops notifications', () => {
    const seen: Array<MediaStreamTrack | null> = [];
    const unsub = engine.onOutputChange((t) => seen.push(t));
    unsub();
    engine.setSource(raw.asTrack());
    expect(seen).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// Mask smoothing constants — exported tuning knobs consumers may read.

describe('mask smoothing constants', () => {
  it('MASK_EMA_ALPHA is a blend weight in (0, 1]', () => {
    expect(MASK_EMA_ALPHA).toBeGreaterThan(0);
    expect(MASK_EMA_ALPHA).toBeLessThanOrEqual(1);
  });

  it('MASK_FEATHER_PX is a positive pixel radius', () => {
    expect(MASK_FEATHER_PX).toBeGreaterThan(0);
  });

  it('SEGMENT_FRAME_INTERVAL is a positive integer', () => {
    expect(Number.isInteger(SEGMENT_FRAME_INTERVAL)).toBe(true);
    expect(SEGMENT_FRAME_INTERVAL).toBeGreaterThanOrEqual(1);
  });
});

// --------------------------------------------------------------------------
// Draw-loop behavior: segmentation frame pacing + smoothed-mask compositing.
// A subclass with a "ready" fake video, recording 2d contexts, and a manual
// tick() (requestFrame captures the RAF callback instead of scheduling)
// lets these tests step the draw loop frame by frame in plain node.

interface CtxOp {
  op: 'drawImage' | 'fillRect' | 'clearRect';
  image?: unknown;
  filter: string;
  alpha: number;
  gco: string;
}

interface RecordingCtx {
  filter: string;
  globalAlpha: number;
  globalCompositeOperation: string;
  fillStyle: string;
  ops: CtxOp[];
  drawImage: (image: unknown) => void;
  fillRect: () => void;
  clearRect: () => void;
}

function makeRecordingCtx(): RecordingCtx {
  const ctx: RecordingCtx = {
    filter: 'none',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    ops: [],
    drawImage(image: unknown) {
      ctx.ops.push({ op: 'drawImage', image, filter: ctx.filter, alpha: ctx.globalAlpha, gco: ctx.globalCompositeOperation });
    },
    fillRect() {
      ctx.ops.push({ op: 'fillRect', filter: ctx.filter, alpha: ctx.globalAlpha, gco: ctx.globalCompositeOperation });
    },
    clearRect() {
      ctx.ops.push({ op: 'clearRect', filter: ctx.filter, alpha: ctx.globalAlpha, gco: ctx.globalCompositeOperation });
    },
  };
  return ctx;
}

class DrawTestEngine extends TestEngine {
  ctxs: RecordingCtx[] = [];
  fakeCanvases: Array<{ width: number; height: number }> = [];
  private pendingFrame: FrameRequestCallback | null = null;

  protected override createVideoElement(_track: MediaStreamTrack): HTMLVideoElement {
    return {
      readyState: 2,
      videoWidth: 640,
      videoHeight: 480,
      pause: jest.fn(),
      srcObject: null,
    } as unknown as HTMLVideoElement;
  }

  protected override createCanvas(width: number, height: number): HTMLCanvasElement {
    this.canvasesCreated++;
    const ctx = makeRecordingCtx();
    this.ctxs.push(ctx);
    const canvas = { width, height, getContext: () => ctx };
    this.fakeCanvases.push(canvas);
    return canvas as unknown as HTMLCanvasElement;
  }

  protected override requestFrame(cb: FrameRequestCallback): number {
    this.framesRequested++;
    this.pendingFrame = cb;
    return this.framesRequested;
  }

  /** Run exactly one draw-loop iteration. */
  tick(): void {
    const cb = this.pendingFrame;
    this.pendingFrame = null;
    cb?.(0);
  }

  // Creation order in buildPipeline: output, bg, person, maskSmooth.
  get personCtx(): RecordingCtx { return this.ctxs[2]; }
  get maskSmoothCanvas(): unknown { return this.fakeCanvases[3]; }
  get maskSmoothCtx(): RecordingCtx { return this.ctxs[3]; }
}

describe('segmentation pacing and mask smoothing (draw loop)', () => {
  let engine: DrawTestEngine;
  let raw: FakeTrack;
  let mask: object;

  beforeEach(() => {
    engine = new DrawTestEngine();
    raw = new FakeTrack();
    mask = { fake: 'mask' };
    engine.setSource(raw.asTrack());
    engine.setBackgroundMode('blur');
  });

  it('with SEGMENT_FRAME_INTERVAL=2, segment() runs on ticks 0,2,4 and skipped ticks reuse the mask', () => {
    expect(SEGMENT_FRAME_INTERVAL).toBe(2); // pacing assumption of this test
    const seg = engine.segmenters[0];
    seg.segment.mockReturnValue(mask);

    for (let i = 0; i < 6; i++) engine.tick();

    expect(seg.segment).toHaveBeenCalledTimes(3); // ticks 0, 2, 4
    // Every tick still composited a person cutout (destination-in draw) —
    // the skipped ticks reused the smoothed mask instead of segmenting.
    const cutouts = engine.personCtx.ops.filter((o) => o.op === 'drawImage' && o.gco === 'destination-in');
    expect(cutouts).toHaveLength(6);
  });

  it('keeps trying every frame while the model is still loading (segment → null)', () => {
    const seg = engine.segmenters[0];
    seg.segment.mockReturnValue(null);

    for (let i = 0; i < 4; i++) engine.tick();

    // No mask yet → no pacing: retry each frame so blur starts ASAP.
    expect(seg.segment).toHaveBeenCalledTimes(4);
    expect(engine.personCtx.ops).toHaveLength(0); // nothing composited
  });

  it('cuts out the person with the SMOOTHED mask, feathered by MASK_FEATHER_PX', () => {
    engine.segmenters[0].segment.mockReturnValue(mask);
    engine.tick();

    const cutout = engine.personCtx.ops.find((o) => o.gco === 'destination-in');
    expect(cutout).toBeDefined();
    expect(cutout!.image).toBe(engine.maskSmoothCanvas); // smoothed, not raw
    expect(cutout!.filter).toBe(`blur(${MASK_FEATHER_PX}px)`);
    // Filter reset after the mask draw.
    expect(engine.personCtx.filter).toBe('none');
  });

  it('seeds the smooth canvas with a full-alpha copy, then blends at MASK_EMA_ALPHA', () => {
    engine.segmenters[0].segment.mockReturnValue(mask);
    engine.tick(); // tick 0: seed
    engine.tick(); // tick 1: reuse (no blend)
    engine.tick(); // tick 2: fresh mask → EMA blend

    const ops = engine.maskSmoothCtx.ops;
    // Seed: cleared then drawn at alpha 1.
    expect(ops[0]).toMatchObject({ op: 'clearRect', alpha: 1 });
    expect(ops[1]).toMatchObject({ op: 'drawImage', image: mask, alpha: 1, gco: 'source-over' });
    // Blend: previous contents faded (destination-out) then the fresh mask
    // drawn source-over, both at MASK_EMA_ALPHA.
    expect(ops[2]).toMatchObject({ op: 'fillRect', alpha: MASK_EMA_ALPHA, gco: 'destination-out' });
    expect(ops[3]).toMatchObject({ op: 'drawImage', image: mask, alpha: MASK_EMA_ALPHA, gco: 'source-over' });
    expect(ops).toHaveLength(4); // nothing blended on the skipped tick
  });
});

// --------------------------------------------------------------------------
// warmup(): preloads models via module-level loader seams, before any
// pipeline exists.

class WarmupProbeEngine extends TestEngine {
  segWarmups = 0;
  faceWarmups = 0;

  protected override warmupSegmentation(): Promise<void> {
    this.segWarmups++;
    return Promise.resolve();
  }

  protected override warmupFaces(): Promise<void> {
    this.faceWarmups++;
    return Promise.resolve();
  }
}

describe('warmup()', () => {
  let engine: WarmupProbeEngine;

  beforeEach(() => {
    engine = new WarmupProbeEngine();
  });

  it("warmup('segmentation') triggers only the segmenter loader", () => {
    engine.warmup('segmentation');
    expect(engine.segWarmups).toBe(1);
    expect(engine.faceWarmups).toBe(0);
  });

  it("warmup('faces') triggers only the landmarker loader", () => {
    engine.warmup('faces');
    expect(engine.segWarmups).toBe(0);
    expect(engine.faceWarmups).toBe(1);
  });

  it("defaults to 'all' and triggers both — with no source or pipeline", () => {
    engine.warmup();
    expect(engine.segWarmups).toBe(1);
    expect(engine.faceWarmups).toBe(1);
    expect(engine.canvasesCreated).toBe(0); // still no pipeline
  });

  it('is safe to call repeatedly', () => {
    engine.warmup('all');
    engine.warmup('all');
    engine.warmup('segmentation');
    expect(engine.segWarmups).toBe(3);
    expect(engine.faceWarmups).toBe(2);
  });

  it('module-level loaders are SSR-safe: resolve as no-ops without window', () => {
    // jest node environment has no window/document.
    expect(typeof window).toBe('undefined');
    return Promise.all([
      expect(warmupSegmenter()).resolves.toBeUndefined(),
      expect(warmupFaceLandmarker()).resolves.toBeUndefined(),
    ]).then(() => undefined);
  });
});
