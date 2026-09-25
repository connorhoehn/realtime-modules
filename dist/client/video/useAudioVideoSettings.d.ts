import { type AudioVideoSettings } from './documentCallTypes';
export declare const AUDIO_VIDEO_SETTINGS_KEY = "call-device-preferences";
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface UseAudioVideoSettingsOptions {
    /** localStorage key. Default `call-device-preferences`. */
    storageKey?: string;
    /** Injectable storage; null = memory only. Defaults to localStorage. */
    storage?: StorageLike | null;
    /** Acquire `previewStream` (camera, and the mic for `micLevel`) while true —
     *  i.e. while the settings drawer is open. Default false. */
    preview?: boolean;
    /** Include the camera in the preview. Default true. */
    previewVideo?: boolean;
    /** Injectable for tests. Defaults to navigator.mediaDevices. */
    mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
}
export interface UseAudioVideoSettingsResult {
    settings: AudioVideoSettings;
    update(patch: Partial<AudioVideoSettings>): void;
    /** getUserMedia constraints for the current settings. */
    constraints(video: boolean): MediaStreamConstraints;
    previewStream: MediaStream | null;
    /** Why the preview could not start (permission denied, no device). */
    previewError: string | null;
    /** Live input level of the selected microphone, 0–1 (0 when no preview). */
    micLevel: number;
    testMic(): Promise<void>;
    testSound(): Promise<void>;
    testMicState: 'idle' | 'recording' | 'playing';
}
/** Parse what is stored, tolerating the older DevicePreferences shape
 *  ({ microphoneId, cameraId, speakerId }) and garbage. */
export declare function readAudioVideoSettings(storage: StorageLike | null, key?: string): AudioVideoSettings;
/** Pure: constraints for a settings value. `auto` quality asks for 720p as an
 *  ideal (what calls asked for before these settings existed); a fixed quality
 *  caps it. Device ids are `ideal`, so an unplugged device falls back. */
export declare function audioVideoConstraints(s: AudioVideoSettings, video: boolean): MediaStreamConstraints;
export declare function useAudioVideoSettings(opts?: UseAudioVideoSettingsOptions): UseAudioVideoSettingsResult;
export {};
//# sourceMappingURL=useAudioVideoSettings.d.ts.map