// useDevicePreferences — the microphone, camera and speaker this person wants
// calls to use. Per browser, because that is where the devices are: a
// preference for "the headset" means nothing on the laptop without it.
//
// Stored under `call-device-preferences`, the key realtime-examples'
// DeviceSettingsPanel and useAudioVideoSettings already use, so the three
// agree on one record.

import { useCallback, useState } from 'react';
import type { DevicePreferences } from './conversationCallTypes';

export const DEVICE_PREFERENCES_KEY = 'call-device-preferences';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** The stored preference, for code that runs outside React (session options). */
export function readDevicePreferences(storage: StorageLike | null = defaultStorage()): DevicePreferences {
  try {
    const raw = storage?.getItem(DEVICE_PREFERENCES_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : {};
    if (!v || typeof v !== 'object') return {};
    const o = v as Record<string, unknown>;
    const out: DevicePreferences = {};
    if (typeof o.microphoneId === 'string' && o.microphoneId) out.microphoneId = o.microphoneId;
    if (typeof o.cameraId === 'string' && o.cameraId) out.cameraId = o.cameraId;
    if (typeof o.speakerId === 'string' && o.speakerId) out.speakerId = o.speakerId;
    return out;
  } catch { return {}; }
}

/**
 * `[prefs, set]`. `storage` defaults to localStorage; pass `null` to keep the
 * preference in memory only. Writing merges into the stored record, so other
 * fields under the same key (useAudioVideoSettings' noise suppression, …)
 * survive.
 */
export function useDevicePreferences(
  storage?: StorageLike | null,
  initial?: DevicePreferences,
): [DevicePreferences, (next: DevicePreferences) => void] {
  const store = storage === undefined ? defaultStorage() : storage;
  const [prefs, setPrefs] = useState<DevicePreferences>(() => ({ ...readDevicePreferences(store), ...(initial ?? {}) }));
  const set = useCallback((next: DevicePreferences) => {
    setPrefs(next);
    if (!store) return;
    try {
      const raw = store.getItem(DEVICE_PREFERENCES_KEY);
      const prev = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const merged: Record<string, unknown> = { ...(prev && typeof prev === 'object' ? prev : {}) };
      for (const k of ['microphoneId', 'cameraId', 'speakerId'] as const) {
        if (next[k]) merged[k] = next[k]; else delete merged[k];
      }
      store.setItem(DEVICE_PREFERENCES_KEY, JSON.stringify(merged));
    } catch { /* per-viewer convenience */ }
  }, [store]);
  return [prefs, set];
}

/** getUserMedia constraints honouring the preference, falling back to any device. */
export function deviceConstraints(p: DevicePreferences, opts: { video: boolean; audio?: boolean }): MediaStreamConstraints {
  return {
    audio: opts.audio === false ? false : p.microphoneId ? { deviceId: { ideal: p.microphoneId } } : true,
    // Same floor as useLVSHangout's default: a clean tile under any decoder budget.
    video: opts.video
      ? {
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 24, max: 30 },
          ...(p.cameraId ? { deviceId: { ideal: p.cameraId } } : {}),
        }
      : false,
  };
}
