/**
 * @jest-environment jsdom
 */
import { describe, it, expect } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useMediaDevices, toDeviceOptions } from '../../../src/client/video/useMediaDevices';
import { useAudioVideoSettings, audioVideoConstraints, readAudioVideoSettings } from '../../../src/client/video/useAudioVideoSettings';
import { DEFAULT_AUDIO_VIDEO_SETTINGS } from '../../../src/client/video/documentCallTypes';

const dev = (kind: string, deviceId: string, label = '') => ({ kind, deviceId, label, groupId: 'g' }) as MediaDeviceInfo;

function fakeMediaDevices(list: MediaDeviceInfo[], gum: () => Promise<MediaStream>) {
  return { enumerateDevices: async () => list, getUserMedia: gum } as any;
}

describe('useMediaDevices', () => {
  it('lists devices and reads granted from labels', async () => {
    const md = fakeMediaDevices([
      dev('audioinput', 'default', 'Default - MacBook Pro Microphone'), dev('audioinput', 'm1', 'MacBook Pro Microphone'),
      dev('videoinput', 'c1', 'FaceTime HD Camera'), dev('audiooutput', 's1', 'MacBook Pro Speakers'),
    ], async () => ({ getTracks: () => [] }) as any);
    const { result } = renderHook(() => useMediaDevices({ mediaDevices: md, permissions: null }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.microphones.map((d) => d.label)).toEqual(['Default - MacBook Pro Microphone', 'MacBook Pro Microphone']);
    expect(result.current.microphones[0].isDefault).toBe(true);
    expect(result.current.cameras[0].label).toBe('FaceTime HD Camera');
    expect(result.current.speakers).toHaveLength(1);
    expect(result.current.permission).toEqual({ microphone: 'granted', camera: 'granted' });
  });

  it('names unlabelled devices and reports prompt; no camera is unavailable', async () => {
    const md = fakeMediaDevices([dev('audioinput', 'a'), dev('audioinput', 'b')], async () => ({ getTracks: () => [] }) as any);
    const { result } = renderHook(() => useMediaDevices({ mediaDevices: md, permissions: null }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.microphones.map((d) => d.label)).toEqual(['Microphone 1', 'Microphone 2']);
    expect(result.current.permission).toEqual({ microphone: 'prompt', camera: 'unavailable' });
  });

  it('a refused getUserMedia reads as denied', async () => {
    const md = fakeMediaDevices([dev('audioinput', 'a'), dev('videoinput', 'c')], async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); });
    const { result } = renderHook(() => useMediaDevices({ mediaDevices: md, permissions: null }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.requestPermission(['audio', 'video']); });
    expect(result.current.permission).toEqual({ microphone: 'denied', camera: 'denied' });
  });

  it('no media API at all is unavailable', () => {
    const { result } = renderHook(() => useMediaDevices({ mediaDevices: undefined as any, permissions: null }));
    // jsdom has no navigator.mediaDevices
    expect(result.current.permission.microphone).toBe('unavailable');
  });

  it('toDeviceOptions skips the communications alias', () => {
    expect(toDeviceOptions([dev('audioinput', 'communications', 'X'), dev('audioinput', 'm', 'Y')]).microphones.map((d) => d.deviceId)).toEqual(['m']);
  });
});

describe('useAudioVideoSettings', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
  };

  it('reads the older DevicePreferences shape and fills defaults', () => {
    const s = memory();
    s.setItem('call-device-preferences', JSON.stringify({ microphoneId: 'm1', cameraId: 'c1' }));
    expect(readAudioVideoSettings(s)).toEqual({ ...DEFAULT_AUDIO_VIDEO_SETTINGS, microphoneId: 'm1', cameraId: 'c1' });
  });

  it('persists while rememberDevices is on, forgets when it is turned off', () => {
    const s = memory();
    const { result } = renderHook(() => useAudioVideoSettings({ storage: s, mediaDevices: {} as any }));
    act(() => { result.current.update({ speakerId: 's1', quality: '480p' }); });
    expect(JSON.parse(s.getItem('call-device-preferences')!)).toMatchObject({ speakerId: 's1', quality: '480p' });
    act(() => { result.current.update({ rememberDevices: false }); });
    expect(s.getItem('call-device-preferences')).toBeNull();
    expect(result.current.settings.speakerId).toBe('s1');
  });

  it('maps settings to constraints', () => {
    const c = audioVideoConstraints({ ...DEFAULT_AUDIO_VIDEO_SETTINGS, microphoneId: 'm1', cameraId: 'c1', quality: '360p', frameRate: 15, noiseSuppression: false }, true);
    expect(c.audio).toMatchObject({ deviceId: { ideal: 'm1' }, noiseSuppression: false, echoCancellation: true });
    expect(c.video).toMatchObject({ deviceId: { ideal: 'c1' }, width: { ideal: 640, max: 640 }, frameRate: { ideal: 15, max: 15 } });
    expect(audioVideoConstraints(DEFAULT_AUDIO_VIDEO_SETTINGS, false).video).toBe(false);
  });

  it('acquires a preview stream only while preview is on, and stops it after', async () => {
    let stopped = 0;
    const stream = { getTracks: () => [{ stop: () => { stopped += 1; } }], getAudioTracks: () => [] } as any;
    const md = { getUserMedia: async () => stream } as any;
    const { result, rerender } = renderHook((p: { preview: boolean }) => useAudioVideoSettings({ storage: null, mediaDevices: md, preview: p.preview }), { initialProps: { preview: true } });
    await waitFor(() => expect(result.current.previewStream).toBe(stream));
    rerender({ preview: false });
    await waitFor(() => expect(result.current.previewStream).toBeNull());
    expect(stopped).toBe(1);
  });
});
