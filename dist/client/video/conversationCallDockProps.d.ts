import type { ReactNode } from 'react';
import type { UseMediaDevicesResult } from './useMediaDevices';
import type { ConversationCallParticipant, ConversationCallPhase, DevicePreferences } from './conversationCallTypes';
/** What the dock reads from a conversation call (a subset of ConversationCallResult). */
export interface ConversationCallDockState {
    phase: ConversationCallPhase;
    call: {
        participants: ConversationCallParticipant[];
        participantCount: number;
    } | null;
    error: {
        message: string;
    } | null;
    callingTo: string | null;
    elapsedMs: number | null;
    activeSpeakerId: string | null;
    self: {
        audioOn: boolean;
        cameraOn: boolean;
        screenSharing: boolean;
    };
    devices: {
        prefs: DevicePreferences;
        set(next: DevicePreferences): void;
        list: Pick<UseMediaDevicesResult, 'microphones' | 'cameras' | 'permission'>;
    };
    toggleMic(): void;
    toggleCamera(): void;
    toggleScreenShare(): void;
    leave(): void | Promise<void>;
    rejoin(): void | Promise<void>;
}
export interface ConversationCallDockUi {
    /** The conversation's name (`#general`, `Alice Chen`). */
    title: string;
    /** Reactions trigger, recording chip, side-panel toggles — before the gear. App-owned. */
    extras?: ReactNode;
    onOpenPeople(): void;
    /** The People panel is open (the button reads pressed). */
    peopleOpen?: boolean;
    onOpenSettings(): void;
    onPopOut?(): void;
    /** The person's camera tile (a `<video>` on `p.stream`); undefined draws their initials. */
    tile(p: ConversationCallParticipant): ReactNode | undefined;
    /** Their shared screen, drawn IN their tile while they share; the camera element then carries their audio. */
    screenTile?(p: ConversationCallParticipant): ReactNode | undefined;
    /** Extra rows in the camera menu ("Blur background…"). */
    cameraMenuItems?: {
        label: string;
        onSelect: () => void;
    }[];
    /** Overrides `state.activeSpeakerId` (the composite measures it). */
    activeSpeakerId?: string | null;
    compact?: boolean;
    'data-testid'?: string;
}
/** Structural mirror of ui-components' `CallDockParticipant`. */
export interface ConversationCallDockParticipant {
    id: string;
    userId: string;
    displayName: string;
    avatarUrl?: string;
    isMuted?: boolean;
    isLocal?: boolean;
    videoElement?: ReactNode;
    audioElement?: ReactNode;
    cameraOn: boolean;
    audioOn: boolean;
    screenSharing: boolean;
    presenting: boolean;
    connection: 'connected' | 'reconnecting';
}
interface DockDeviceControl {
    on: boolean;
    onToggle: () => void;
    devices: {
        deviceId: string;
        label: string;
    }[];
    selectedDeviceId?: string;
    onSelectDevice: (deviceId: string) => void;
    permission: 'prompt' | 'granted' | 'denied' | 'unavailable';
    extraItems?: {
        label: string;
        onSelect: () => void;
    }[];
}
/** Structural mirror of the ui-components `CallDockProps` this mapping sets. */
export interface ConversationCallDockProps {
    title: string;
    participantCount: number;
    elapsedMs: number | null;
    phase: 'calling' | 'connecting' | 'active' | 'reconnecting' | 'ended' | 'error';
    callingTo?: string;
    participants: ConversationCallDockParticipant[];
    localParticipantId: string;
    activeSpeakerId: string | null;
    mic: DockDeviceControl;
    camera: DockDeviceControl;
    screenShare: {
        on: boolean;
        disabledReason?: string;
        onToggle: () => void;
    };
    onOpenPeople: () => void;
    peopleOpen?: boolean;
    onOpenSettings: () => void;
    extras?: ReactNode;
    onPopOut: () => void;
    onLeave: () => void;
    error?: {
        message: string;
        onRetry: () => void;
        title?: string;
        retryLabel?: string;
    };
    onDismiss?: () => void;
    compact: boolean;
    'data-testid'?: string;
}
/** The call phase as the dock's (null = draw nothing: no call, or a ring the toast answers). */
export declare const DOCK_PHASE: Record<ConversationCallPhase, ConversationCallDockProps['phase'] | null>;
/**
 * The dock for this call, or null while there is nothing to dock (idle, or a
 * ring — the toast answers those).
 */
export declare function conversationCallDockProps(s: ConversationCallDockState, ui: ConversationCallDockUi): ConversationCallDockProps | null;
export {};
//# sourceMappingURL=conversationCallDockProps.d.ts.map