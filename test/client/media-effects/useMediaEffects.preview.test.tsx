/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/media-effects/useMediaEffects.preview.test.tsx
//
// The draft/committed split on useMediaEffects — "let me try this filter on
// before the whole call sees it".
//
// These run the REAL MediaEffectsEngine state machine (subclassed with stubbed
// DOM factories, same trick as engine.test.ts) via the hook's `createEngine`
// seam, so the assertions are about real activation edges and real output
// identity, not about a mock's bookkeeping.
//
// Load-bearing invariants pinned here:
//   - no session open  → every code path is what it was before preview existed
//                        (one engine ever created; setters hit live directly)
//   - session open     → setters touch the DRAFT ONLY; live outputTrack keeps
//                        both its identity AND its rendered settings
//   - previewTrack     → live output while the draft still matches live (no
//                        second pipeline at all), a second engine's output
//                        once it diverges, null with no session
//   - applyPreview()   → live output identity survives an active→active commit
//   - persistence      → only committed settings reach storage
//   - teardown         → clone stopped + preview engine disposed on apply,
//                        cancel, unmount, detach, and source-ended

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { useMediaEffects } from '../../../src/client/media-effects/useMediaEffects';
import { MediaEffectsEngine } from '../../../src/client/media-effects/engine';
import type { PersonSegmenter } from '../../../src/client/media-effects/segmenter';
import type { FaceTracker } from '../../../src/client/media-effects/faceLandmarker';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeTrack {
  kind = 'video';
  stop = jest.fn();
  clones: FakeTrack[] = [];
  private listeners = new Map<string, Set<() => void>>();

  constructor(readonly label: string) {}

  addEventListener = jest.fn((type: string, cb: () => void) => {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  });

  removeEventListener = jest.fn((type: string, cb: () => void) => {
    this.listeners.get(type)?.delete(cb);
  });

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  getSettings() {
    return { width: 640, height: 480 };
  }

  clone(): MediaStreamTrack {
    const c = new FakeTrack(`${this.label}#clone${this.clones.length}`);
    this.clones.push(c);
    return c.asTrack();
  }

  fireEnded() {
    for (const cb of [...(this.listeners.get('ended') ?? [])]) cb();
  }

  asTrack(): MediaStreamTrack {
    return this as unknown as MediaStreamTrack;
  }
}

class TestEngine extends MediaEffectsEngine {
  canvasTracks: FakeTrack[] = [];
  isDisposed = false;
  private static seq = 0;
  readonly id = TestEngine.seq++;

  override dispose(): void {
    this.isDisposed = true;
    super.dispose();
  }

  protected override createVideoElement(): HTMLVideoElement {
    return {
      readyState: 0,
      videoWidth: 0,
      videoHeight: 0,
      pause: jest.fn(),
      srcObject: null,
    } as unknown as HTMLVideoElement;
  }

  protected override createCanvas(width: number, height: number): HTMLCanvasElement {
    return { width, height, getContext: () => null } as unknown as HTMLCanvasElement;
  }

  protected override captureCanvasStream(): MediaStream | null {
    const track = new FakeTrack(`canvas${this.id}.${this.canvasTracks.length}`);
    this.canvasTracks.push(track);
    return {
      getVideoTracks: () => [track.asTrack()],
      getTracks: () => [track.asTrack()],
    } as unknown as MediaStream;
  }

  protected override createSegmenter(): PersonSegmenter {
    return { warmup: jest.fn(), close: jest.fn(), segment: jest.fn(() => null) } as unknown as PersonSegmenter;
  }

  protected override createFaceTracker(): FaceTracker {
    return { warmup: jest.fn(), close: jest.fn(), detect: jest.fn(() => null) } as unknown as FaceTracker;
  }

  protected override loadBackgroundImage(): void { /* no-op */ }
  protected override requestFrame(): number { return 1; }
  protected override cancelFrame(): void { /* no-op */ }
  protected override warmupSegmentation(): Promise<void> { return Promise.resolve(); }
  protected override warmupFaces(): Promise<void> { return Promise.resolve(); }
  protected override now(): number { return 0; }
}

/** Engine factory that records every engine it hands out. */
function engineFactory() {
  const engines: TestEngine[] = [];
  return {
    engines,
    createEngine: () => {
      const e = new TestEngine();
      engines.push(e);
      return e;
    },
  };
}

class FakeStorage {
  map = new Map<string, string>();
  getItem = jest.fn((k: string) => this.map.get(k) ?? null);
  setItem = jest.fn((k: string, v: string) => { this.map.set(k, v); });
}

/** Point window.localStorage at a fake we can inspect. */
function installStorage(): FakeStorage {
  const fake = new FakeStorage();
  Object.defineProperty(window, 'localStorage', {
    value: fake,
    configurable: true,
    writable: true,
  });
  return fake;
}

/** Snapshot of everything the live engine renders. */
function liveSettings(engine: TestEngine) {
  return {
    filterId: engine.getFilterId(),
    backgroundMode: engine.getBackgroundMode(),
    backgroundImageUrl: engine.getBackgroundImageUrl(),
    faceSpriteId: engine.getFaceSpriteId(),
  };
}

// ---------------------------------------------------------------------------

describe('useMediaEffects — no preview session (unchanged legacy path)', () => {
  let factory: ReturnType<typeof engineFactory>;

  beforeEach(() => { factory = engineFactory(); });

  it('setters drive the live engine directly and never build a preview engine', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    const source = new FakeTrack('cam');

    act(() => { result.current.attach(source.asTrack()); });
    // Inactive: identity passthrough, exactly as before preview existed.
    expect(result.current.outputTrack).toBe(source.asTrack());

    act(() => { result.current.setFilter('grayscale'); });

    const live = factory.engines[0];
    expect(factory.engines).toHaveLength(1); // no second engine, ever
    expect(live.getFilterId()).toBe('grayscale');
    expect(result.current.filterId).toBe('grayscale');
    expect(result.current.active).toBe(true);
    // Activation edge still swaps the output to the canvas track.
    expect(result.current.outputTrack).toBe(live.canvasTracks[0].asTrack());

    act(() => { result.current.setBackgroundMode('blur'); });
    expect(live.getBackgroundMode()).toBe('blur');
    // Flipping settings while active never churns identity.
    expect(result.current.outputTrack).toBe(live.canvasTracks[0].asTrack());

    act(() => { result.current.setFilter('none'); result.current.setBackgroundMode('none'); });
    expect(result.current.active).toBe(false);
    expect(result.current.outputTrack).toBe(source.asTrack());
  });

  it('exposes an empty preview surface and ignores apply/cancel', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    act(() => { result.current.attach(new FakeTrack('cam').asTrack()); });

    expect(result.current.draft).toBeNull();
    expect(result.current.isDirty).toBe(false);
    expect(result.current.previewTrack).toBeNull();

    const before = liveSettings(factory.engines[0]);
    act(() => { result.current.applyPreview(); result.current.cancelPreview(); });
    expect(liveSettings(factory.engines[0])).toEqual(before);
    expect(result.current.draft).toBeNull();
    expect(factory.engines).toHaveLength(1);
  });

  it('never clones the source track when no session is opened', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    const source = new FakeTrack('cam');
    act(() => { result.current.attach(source.asTrack()); });
    act(() => { result.current.setFaceSpriteId('sunglasses'); });
    expect(source.clones).toHaveLength(0);
  });
});

describe('useMediaEffects — live is untouched while drafting', () => {
  let factory: ReturnType<typeof engineFactory>;

  beforeEach(() => { factory = engineFactory(); });

  it('setters write to the draft only; live keeps its track AND its settings', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    const source = new FakeTrack('cam');
    act(() => { result.current.attach(source.asTrack()); });
    act(() => { result.current.setFilter('sepia'); }); // committed, pre-session

    const live = factory.engines[0];
    const liveTrackBefore = result.current.outputTrack;
    const liveSettingsBefore = liveSettings(live);

    act(() => { result.current.beginPreview(); });
    act(() => {
      result.current.setFilter('grayscale');
      result.current.setBackgroundMode('blur');
      result.current.setFaceSpriteId('sunglasses');
    });

    // THE invariant: nothing peers can see has moved.
    expect(liveSettings(live)).toEqual(liveSettingsBefore);
    expect(result.current.outputTrack).toBe(liveTrackBefore);
    // Committed view of the controller is unchanged too.
    expect(result.current.filterId).toBe('sepia');
    expect(result.current.backgroundMode).toBe('none');
    expect(result.current.faceSpriteId).toBeNull();

    // ...while the draft has moved.
    expect(result.current.draft).toEqual({
      filterId: 'grayscale',
      backgroundMode: 'blur',
      backgroundImageUrl: null,
      faceSpriteId: 'sunglasses',
    });
    expect(result.current.isDirty).toBe(true);
  });

  it('backgroundImageUrl also stays off the live engine while drafting', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    act(() => { result.current.attach(new FakeTrack('cam').asTrack()); });
    act(() => { result.current.beginPreview(); });
    act(() => { result.current.setBackgroundImageUrl('https://example.test/a.png'); });

    expect(factory.engines[0].getBackgroundImageUrl()).toBeNull();
    expect(result.current.backgroundImageUrl).toBeNull();
    expect(result.current.draft?.backgroundImageUrl).toBe('https://example.test/a.png');
  });
});

describe('useMediaEffects — previewTrack production and cost', () => {
  let factory: ReturnType<typeof engineFactory>;

  beforeEach(() => { factory = engineFactory(); });

  it('costs nothing while the draft still matches live', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    const source = new FakeTrack('cam');
    act(() => { result.current.attach(source.asTrack()); });
    act(() => { result.current.setFilter('sepia'); });

    act(() => { result.current.beginPreview(); });
    expect(factory.engines).toHaveLength(1); // no second pipeline
    expect(source.clones).toHaveLength(0);   // no clone
    expect(result.current.isDirty).toBe(false);
    // Self-view shows exactly what is being published.
    expect(result.current.previewTrack).toBe(result.current.outputTrack);

    // Re-selecting the same value is not a divergence.
    act(() => { result.current.setFilter('sepia'); });
    expect(factory.engines).toHaveLength(1);
  });

  it('builds a second engine on a cloned source at first divergence', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    const source = new FakeTrack('cam');
    act(() => { result.current.attach(source.asTrack()); });

    act(() => { result.current.beginPreview(); });
    act(() => { result.current.setFilter('grayscale'); });

    expect(factory.engines).toHaveLength(2);
    const preview = factory.engines[1];
    expect(source.clones).toHaveLength(1);
    expect(preview.getSource()).toBe(source.clones[0].asTrack());
    expect(preview.getFilterId()).toBe('grayscale');
    // Draft is active → the preview engine's canvas track is the self-view.
    expect(result.current.previewTrack).toBe(preview.canvasTracks[0].asTrack());
    expect(result.current.previewTrack).not.toBe(result.current.outputTrack);
  });

  it('keeps the preview engine when the draft wanders back to the live settings', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    act(() => { result.current.attach(new FakeTrack('cam').asTrack()); });
    act(() => { result.current.beginPreview(); });
    act(() => { result.current.setFilter('grayscale'); });
    act(() => { result.current.setFilter('none'); });

    expect(result.current.isDirty).toBe(false);
    expect(factory.engines).toHaveLength(2);      // not torn down mid-session
    expect(factory.engines[1].isDisposed).toBe(false);
    expect(factory.engines[1].getFilterId()).toBe('none');
  });

  it('opens a session with no camera attached without crashing', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    act(() => { result.current.beginPreview(); });
    act(() => { result.current.setFilter('grayscale'); });

    expect(result.current.draft?.filterId).toBe('grayscale');
    expect(result.current.previewTrack).toBeNull(); // nothing to render yet
  });

  it('picks up a camera that arrives after the draft already diverged', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    act(() => { result.current.beginPreview(); });
    act(() => { result.current.setFilter('grayscale'); });
    expect(factory.engines).toHaveLength(0);

    const source = new FakeTrack('cam');
    act(() => { result.current.attach(source.asTrack()); });

    expect(source.clones).toHaveLength(1);
    expect(factory.engines).toHaveLength(2);
    expect(factory.engines[1].getFilterId()).toBe('grayscale');
    expect(result.current.previewTrack).toBe(factory.engines[1].canvasTracks[0].asTrack());
    // Live is still clean — the draft never leaked into the published track.
    expect(factory.engines[0].getFilterId()).toBe('none');
    expect(result.current.outputTrack).toBe(source.asTrack());
  });
});

describe('useMediaEffects — applyPreview', () => {
  let factory: ReturnType<typeof engineFactory>;

  beforeEach(() => { factory = engineFactory(); });

  it('commits the draft to live and ends the session', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    const source = new FakeTrack('cam');
    act(() => { result.current.attach(source.asTrack()); });

    act(() => { result.current.beginPreview(); });
    act(() => {
      result.current.setFilter('grayscale');
      result.current.setBackgroundMode('blur');
    });
    act(() => { result.current.applyPreview(); });

    const live = factory.engines[0];
    expect(liveSettings(live)).toMatchObject({ filterId: 'grayscale', backgroundMode: 'blur' });
    expect(result.current.filterId).toBe('grayscale');
    expect(result.current.backgroundMode).toBe('blur');
    expect(result.current.draft).toBeNull();
    expect(result.current.isDirty).toBe(false);
    expect(result.current.previewTrack).toBeNull();
  });

  it('keeps the live output track identity across an active→active commit', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    act(() => { result.current.attach(new FakeTrack('cam').asTrack()); });
    act(() => { result.current.setFilter('sepia'); }); // live already active

    const trackBefore = result.current.outputTrack;
    expect(trackBefore).toBe(factory.engines[0].canvasTracks[0].asTrack());

    act(() => { result.current.beginPreview(); });
    act(() => {
      result.current.setFilter('grayscale');
      result.current.setBackgroundMode('blur');
      result.current.setFaceSpriteId('sunglasses');
    });
    act(() => { result.current.applyPreview(); });

    // No renegotiation: the published track object never changed.
    expect(result.current.outputTrack).toBe(trackBefore);
    expect(factory.engines[0].canvasTracks).toHaveLength(1); // no rebuild
  });

  it('disposes the preview engine and stops the clone', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    const source = new FakeTrack('cam');
    act(() => { result.current.attach(source.asTrack()); });
    act(() => { result.current.beginPreview(); });
    act(() => { result.current.setFilter('grayscale'); });
    act(() => { result.current.applyPreview(); });

    expect(factory.engines[1].isDisposed).toBe(true);
    expect(source.clones[0].stop).toHaveBeenCalledTimes(1);
    expect(source.stop).not.toHaveBeenCalled(); // never the caller's track
  });
});

describe('useMediaEffects — cancelPreview', () => {
  let factory: ReturnType<typeof engineFactory>;

  beforeEach(() => { factory = engineFactory(); });

  it('discards the draft and leaves live untouched', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    const source = new FakeTrack('cam');
    act(() => { result.current.attach(source.asTrack()); });
    act(() => { result.current.setFilter('sepia'); });

    const before = liveSettings(factory.engines[0]);
    const trackBefore = result.current.outputTrack;

    act(() => { result.current.beginPreview(); });
    act(() => { result.current.setFaceSpriteId('sunglasses'); });
    act(() => { result.current.cancelPreview(); });

    expect(liveSettings(factory.engines[0])).toEqual(before);
    expect(result.current.outputTrack).toBe(trackBefore);
    expect(result.current.filterId).toBe('sepia');
    expect(result.current.faceSpriteId).toBeNull();
    expect(result.current.draft).toBeNull();
    expect(result.current.previewTrack).toBeNull();
    expect(factory.engines[1].isDisposed).toBe(true);
    expect(source.clones[0].stop).toHaveBeenCalledTimes(1);
  });
});

describe('useMediaEffects — session edge cases', () => {
  let factory: ReturnType<typeof engineFactory>;

  beforeEach(() => { factory = engineFactory(); });

  it('beginPreview() twice does not clobber an in-progress draft', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    act(() => { result.current.attach(new FakeTrack('cam').asTrack()); });
    act(() => { result.current.beginPreview(); });
    act(() => { result.current.setFilter('grayscale'); });
    const draftBefore = result.current.draft;

    act(() => { result.current.beginPreview(); });

    expect(result.current.draft).toEqual(draftBefore);
    expect(result.current.isDirty).toBe(true);
    expect(factory.engines).toHaveLength(2); // no extra engine either
  });

  it('a source track that ends mid-session cancels the session and stops the clone', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    const source = new FakeTrack('cam');
    act(() => { result.current.attach(source.asTrack()); });
    act(() => { result.current.setFilter('sepia'); });
    act(() => { result.current.beginPreview(); });
    act(() => { result.current.setFilter('grayscale'); });

    act(() => { source.fireEnded(); });

    expect(result.current.draft).toBeNull();
    expect(result.current.previewTrack).toBeNull();
    expect(factory.engines[1].isDisposed).toBe(true);
    expect(source.clones[0].stop).toHaveBeenCalledTimes(1);
    // Committed settings survive the dead camera.
    expect(result.current.filterId).toBe('sepia');
  });

  it('unmounting mid-session disposes both engines and stops the clone', () => {
    const { result, unmount } = renderHook(() =>
      useMediaEffects({ createEngine: factory.createEngine }));
    const source = new FakeTrack('cam');
    act(() => { result.current.attach(source.asTrack()); });
    act(() => { result.current.beginPreview(); });
    act(() => { result.current.setFilter('grayscale'); });

    unmount();

    expect(factory.engines[0].isDisposed).toBe(true);
    expect(factory.engines[1].isDisposed).toBe(true);
    expect(source.clones[0].stop).toHaveBeenCalledTimes(1);
    expect(source.stop).not.toHaveBeenCalled();
    // 'ended' watches unhooked — no listener left pointing at a dead hook.
    expect(source.listenerCount('ended')).toBe(0);
  });

  it('detach() mid-session cancels the session', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    const source = new FakeTrack('cam');
    act(() => { result.current.attach(source.asTrack()); });
    act(() => { result.current.beginPreview(); });
    act(() => { result.current.setFilter('grayscale'); });
    act(() => { result.current.detach(); });

    expect(result.current.draft).toBeNull();
    expect(factory.engines[1].isDisposed).toBe(true);
    expect(source.clones[0].stop).toHaveBeenCalledTimes(1);
  });

  it('attach() mid-session re-points the preview at the new camera', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    const first = new FakeTrack('cam1');
    const second = new FakeTrack('cam2');
    act(() => { result.current.attach(first.asTrack()); });
    act(() => { result.current.beginPreview(); });
    act(() => { result.current.setFilter('grayscale'); });

    act(() => { result.current.attach(second.asTrack()); });

    expect(first.clones[0].stop).toHaveBeenCalledTimes(1); // stale clone released
    expect(second.clones).toHaveLength(1);
    expect(factory.engines).toHaveLength(3);
    expect(factory.engines[2].getSource()).toBe(second.clones[0].asTrack());
    expect(factory.engines[2].getFilterId()).toBe('grayscale'); // draft carried over
    expect(result.current.draft?.filterId).toBe('grayscale');
  });

  it('survives a source track without clone() by sharing it (and never stopping it)', () => {
    const { result } = renderHook(() => useMediaEffects({ createEngine: factory.createEngine }));
    const source = new FakeTrack('cam');
    (source as { clone?: unknown }).clone = undefined;

    act(() => { result.current.attach(source.asTrack()); });
    act(() => { result.current.beginPreview(); });
    act(() => { result.current.setFilter('grayscale'); });

    expect(factory.engines[1].getSource()).toBe(source.asTrack());
    act(() => { result.current.cancelPreview(); });
    expect(source.stop).not.toHaveBeenCalled();
  });
});

describe('useMediaEffects — persistence records committed settings only', () => {
  let factory: ReturnType<typeof engineFactory>;
  let storage: FakeStorage;

  beforeEach(() => {
    factory = engineFactory();
    storage = installStorage();
  });

  it('an abandoned preview never reaches storage', () => {
    const { result } = renderHook(() =>
      useMediaEffects({ persistKey: 'fx', createEngine: factory.createEngine }));
    act(() => { result.current.attach(new FakeTrack('cam').asTrack()); });

    act(() => { result.current.beginPreview(); });
    act(() => { result.current.setFilter('grayscale'); result.current.setBackgroundMode('blur'); });
    expect(JSON.parse(storage.map.get('fx')!)).toMatchObject({
      filterId: 'none', backgroundMode: 'none',
    });

    act(() => { result.current.cancelPreview(); });
    expect(JSON.parse(storage.map.get('fx')!)).toMatchObject({
      filterId: 'none', backgroundMode: 'none',
    });
  });

  it('applyPreview persists the committed result', () => {
    const { result } = renderHook(() =>
      useMediaEffects({ persistKey: 'fx', createEngine: factory.createEngine }));
    act(() => { result.current.attach(new FakeTrack('cam').asTrack()); });
    act(() => { result.current.beginPreview(); });
    act(() => { result.current.setFilter('grayscale'); });
    act(() => { result.current.applyPreview(); });

    expect(JSON.parse(storage.map.get('fx')!)).toMatchObject({ filterId: 'grayscale' });
  });

  it('restores committed settings on a fresh mount', () => {
    storage.map.set('fx', JSON.stringify({
      filterId: 'sepia', backgroundMode: 'none', backgroundImageUrl: null, faceSpriteId: null,
    }));
    const { result } = renderHook(() =>
      useMediaEffects({ persistKey: 'fx', createEngine: factory.createEngine }));

    expect(result.current.filterId).toBe('sepia');
    act(() => { result.current.beginPreview(); });
    expect(result.current.draft).toMatchObject({ filterId: 'sepia' });
  });
});
