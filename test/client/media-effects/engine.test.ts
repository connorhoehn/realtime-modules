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
import { MediaEffectsEngine } from '../../../src/client/media-effects/engine';
import type { PersonSegmenter } from '../../../src/client/media-effects/segmenter';
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

  protected override requestFrame(): number {
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
    expect(engine.canvasesCreated).toBe(3); // output + bg + person
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
    expect(engine.canvasesCreated).toBe(3); // no second pipeline
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
    expect(engine.canvasesCreated).toBe(3);
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
