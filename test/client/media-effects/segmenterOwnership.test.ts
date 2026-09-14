/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/media-effects/segmenterOwnership.test.ts
//
// jsdom because warmupSegmenter() is a no-op without window/document (the
// SSR guard), and the warm-slot handoff is half of what this pins.
//
// Every PersonSegmenter / FaceTracker owns its MediaPipe instance. The
// failure this pins: useMediaEffects builds a second engine for the settings
// dialog's preview, and when both wrappers borrowed one module-level
// singleton, the preview's teardown closed the graph the LIVE call was still
// drawing with — every frame after that threw
// `AddPacketToInputStream() is called before StartRun()` and the mask froze.
//
// No DOM: segment()/detect() bail before touching `document` when the video
// reports no dimensions, which is enough to drive the acquire path.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

interface FakeInstance { id: number; closed: boolean; close: jest.Mock }
let created: FakeInstance[] = [];
const makeInstance = (): FakeInstance => {
  const inst: FakeInstance = { id: created.length + 1, closed: false, close: jest.fn() };
  inst.close.mockImplementation(() => { inst.closed = true; });
  created.push(inst);
  return inst;
};

jest.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: jest.fn(async () => ({})) },
  ImageSegmenter: { createFromOptions: jest.fn(async () => makeInstance()) },
  FaceLandmarker: { createFromOptions: jest.fn(async () => makeInstance()) },
}));

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const noFrame = { videoWidth: 0, videoHeight: 0 } as unknown as HTMLVideoElement;

// Module state (the warm slot) must start clean per test.
beforeEach(() => {
  jest.resetModules();
  created = [];
});

async function loadSegmenterModule() {
  return import('../../../src/client/media-effects/segmenter');
}
async function loadLandmarkerModule() {
  return import('../../../src/client/media-effects/faceLandmarker');
}

describe('PersonSegmenter ownership', () => {
  it('two segmenters hold two instances; closing one leaves the other running', async () => {
    const { PersonSegmenter } = await loadSegmenterModule();
    const live = new PersonSegmenter();
    const preview = new PersonSegmenter();

    expect(live.segment(noFrame, 0)).toBeNull();
    expect(preview.segment(noFrame, 0)).toBeNull();
    await flush(); await flush();

    expect(created).toHaveLength(2);
    preview.close();
    expect(created.filter((i) => i.closed)).toHaveLength(1);

    // The live one is intact: it still bails on dimensions, not on a
    // missing instance (a missing instance would start another load).
    live.segment(noFrame, 0);
    await flush();
    expect(created).toHaveLength(2);
    live.close();
    expect(created.every((i) => i.closed)).toBe(true);
  });

  it('the warm instance is claimed by the first segmenter, not shared', async () => {
    const { PersonSegmenter, warmupSegmenter } = await loadSegmenterModule();
    await warmupSegmenter();
    expect(created).toHaveLength(1);

    const first = new PersonSegmenter();
    first.segment(noFrame, 0);
    await flush();
    // Claimed the warm one: no second build.
    expect(created).toHaveLength(1);

    const second = new PersonSegmenter();
    second.segment(noFrame, 0);
    await flush(); await flush();
    // The warm slot is empty now, so this one builds its own.
    expect(created).toHaveLength(2);

    first.close();
    expect(created[0].closed).toBe(true);
    expect(created[1].closed).toBe(false);
  });

  it('a segmenter closed mid-load releases the instance when it arrives', async () => {
    const { PersonSegmenter } = await loadSegmenterModule();
    const s = new PersonSegmenter();
    s.segment(noFrame, 0);
    s.close();
    await flush(); await flush();
    expect(created).toHaveLength(1);
    expect(created[0].closed).toBe(true);
  });

  it('close() does not stop a later segment() from acquiring again', async () => {
    const { PersonSegmenter } = await loadSegmenterModule();
    const s = new PersonSegmenter();
    s.segment(noFrame, 0);
    await flush(); await flush();
    s.close();
    s.segment(noFrame, 0);
    await flush(); await flush();
    expect(created).toHaveLength(2);
    expect(created[1].closed).toBe(false);
  });
});

describe('FaceTracker ownership', () => {
  it('two trackers hold two instances; closing one leaves the other running', async () => {
    const { FaceTracker } = await loadLandmarkerModule();
    const live = new FaceTracker();
    const preview = new FaceTracker();
    expect(live.detect(noFrame, 0)).toBeNull();
    expect(preview.detect(noFrame, 0)).toBeNull();
    await flush(); await flush();
    expect(created).toHaveLength(2);
    preview.close();
    expect(created.filter((i) => i.closed)).toHaveLength(1);
  });

  it('the warm instance is claimed once', async () => {
    const { FaceTracker, warmupFaceLandmarker } = await loadLandmarkerModule();
    await warmupFaceLandmarker();
    const a = new FaceTracker();
    a.detect(noFrame, 0);
    await flush();
    expect(created).toHaveLength(1);
    const b = new FaceTracker();
    b.detect(noFrame, 0);
    await flush(); await flush();
    expect(created).toHaveLength(2);
  });
});
