import type { DeviceOption, MediaPermission } from './documentCallTypes';
export interface UseMediaDevicesOptions {
    /** Ask for mic + camera on mount (shows the browser prompt). Default false. */
    requestOnMount?: boolean;
    /** Injectable for tests / non-browser hosts. Defaults to navigator.mediaDevices. */
    mediaDevices?: Pick<MediaDevices, 'enumerateDevices' | 'getUserMedia'> & Partial<Pick<MediaDevices, 'addEventListener' | 'removeEventListener'>>;
    /** Injectable Permissions API. Defaults to navigator.permissions; null disables it. */
    permissions?: {
        query(desc: {
            name: string;
        }): Promise<{
            state: string;
            onchange?: unknown;
            addEventListener?: (t: string, h: () => void) => void;
            removeEventListener?: (t: string, h: () => void) => void;
        }>;
    } | null;
}
export interface UseMediaDevicesResult {
    microphones: DeviceOption[];
    cameras: DeviceOption[];
    speakers: DeviceOption[];
    permission: {
        microphone: MediaPermission;
        camera: MediaPermission;
    };
    /** False where HTMLMediaElement.setSinkId is missing (Safari) — hide the Speakers select. */
    speakerSelectionSupported: boolean;
    /** True until the first enumeration finishes. */
    loading: boolean;
    refresh(): Promise<void>;
    requestPermission(kinds: ('audio' | 'video')[]): Promise<void>;
}
export declare function isSpeakerSelectionSupported(): boolean;
/** Turn a MediaDeviceInfo list into labelled options per kind. */
export declare function toDeviceOptions(list: ReadonlyArray<Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label' | 'groupId'>>): {
    microphones: DeviceOption[];
    cameras: DeviceOption[];
    speakers: DeviceOption[];
};
export declare function useMediaDevices(opts?: UseMediaDevicesOptions): UseMediaDevicesResult;
//# sourceMappingURL=useMediaDevices.d.ts.map