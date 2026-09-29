import type { DevicePreferences } from './conversationCallTypes';
export declare const DEVICE_PREFERENCES_KEY = "call-device-preferences";
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
/** The stored preference, for code that runs outside React (session options). */
export declare function readDevicePreferences(storage?: StorageLike | null): DevicePreferences;
/**
 * `[prefs, set]`. `storage` defaults to localStorage; pass `null` to keep the
 * preference in memory only. Writing merges into the stored record, so other
 * fields under the same key (useAudioVideoSettings' noise suppression, …)
 * survive.
 */
export declare function useDevicePreferences(storage?: StorageLike | null, initial?: DevicePreferences): [DevicePreferences, (next: DevicePreferences) => void];
/** getUserMedia constraints honouring the preference, falling back to any device. */
export declare function deviceConstraints(p: DevicePreferences, opts: {
    video: boolean;
}): MediaStreamConstraints;
export {};
//# sourceMappingURL=useDevicePreferences.d.ts.map