/**
 * @jest-environment jsdom
 */
// A busy camera must not cost you the call.
//
// Another app holding the webcam — a second tab, Zoom, Photo Booth — rejects
// the whole getUserMedia, so asking for video AND audio got you neither and
// the call ended before it started. Observed in the browser as
// NotReadableError "Could not start video source", after which the session
// goes to `failed` and the overlay tears it down: a click that appears to do
// nothing, with the real reason never reaching the person.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { acquireLocalMedia } from '../../src/client/video/useLVSHangout';

const AV: MediaStreamConstraints = { audio: true, video: true };

function mockGum(impl: (c: MediaStreamConstraints) => Promise<unknown>) {
  const getUserMedia = jest.fn(impl as never);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  return getUserMedia;
}

const AUDIO_STREAM = { id: 'audio-only' } as unknown as MediaStream;
const AV_STREAM = { id: 'audio-video' } as unknown as MediaStream;

describe('acquireLocalMedia', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns the stream when everything opens', async () => {
    const gum = mockGum(async () => AV_STREAM);
    const out = await acquireLocalMedia(AV);
    expect(out.stream).toBe(AV_STREAM);
    expect(out.videoUnavailable).toBeNull();
    expect(out.error).toBeNull();
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it('falls back to audio when the camera is held by something else', async () => {
    const gum = mockGum(async (c) => {
      if (c.video) throw new DOMException('Could not start video source', 'NotReadableError');
      return AUDIO_STREAM;
    });
    const out = await acquireLocalMedia(AV);

    expect(out.stream).toBe(AUDIO_STREAM);
    // Not an `error`: the call is up, and consumers treat error as fatal —
    // which is exactly how the whole call was being torn down.
    expect(out.error).toBeNull();
    expect(out.videoUnavailable).toMatch(/camera unavailable/i);
    expect((gum.mock.calls[1][0] as MediaStreamConstraints).video).toBe(false);
  });

  it.each(['TrackStartError', 'AbortError'])('treats %s as a busy camera too', async (name) => {
    mockGum(async (c) => {
      if (c.video) throw new DOMException('busy', name);
      return AUDIO_STREAM;
    });
    const out = await acquireLocalMedia(AV);
    expect(out.stream).toBe(AUDIO_STREAM);
  });

  it('does not retry when permission was refused — there is nothing to join with', async () => {
    const gum = mockGum(async () => { throw new DOMException('Permission denied', 'NotAllowedError'); });
    const out = await acquireLocalMedia(AV);
    expect(out.stream).toBeNull();
    expect(out.error).toMatch(/permission denied/i);
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it('does not retry an audio-only request — dropping video leaves nothing', async () => {
    const gum = mockGum(async () => { throw new DOMException('busy', 'NotReadableError'); });
    const out = await acquireLocalMedia({ audio: true });
    expect(out.stream).toBeNull();
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it('reports the audio failure when the fallback fails too', async () => {
    mockGum(async (c) => {
      if (c.video) throw new DOMException('busy', 'NotReadableError');
      throw new DOMException('No microphone found', 'NotFoundError');
    });
    const out = await acquireLocalMedia(AV);
    expect(out.stream).toBeNull();
    expect(out.error).toMatch(/no microphone/i);
    expect(out.videoUnavailable).toBeNull();
  });
});
