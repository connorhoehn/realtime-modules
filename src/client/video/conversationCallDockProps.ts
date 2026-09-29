// conversationCallDockProps — the conversation call as ui-components'
// `CallDock` props, so the dock above a chat composer is a function of the
// call's state. Pure. Ported from realtime-examples' HangoutShelfDock.
//
// RM does not depend on ui-components, so the output type below is a
// structural mirror of the `CallDockProps` fields this sets (ui-components'
// ConversationCallDock checks the two agree at compile time).
//
// The input is `ConversationCallDockState`: the slice of useConversationCall's
// result the dock reads. A host that owns its own call state (realtime-examples'
// overlay) builds that slice from it and gets the same dock.

import type { ReactNode } from 'react';
import type { UseMediaDevicesResult } from './useMediaDevices';
import type {
  ConversationCallParticipant,
  ConversationCallPhase,
  DevicePreferences,
} from './conversationCallTypes';

/** What the dock reads from a conversation call (a subset of ConversationCallResult). */
export interface ConversationCallDockState {
  phase: ConversationCallPhase;
  call: { participants: ConversationCallParticipant[]; participantCount: number } | null;
  error: { message: string } | null;
  callingTo: string | null;
  elapsedMs: number | null;
  activeSpeakerId: string | null;
  self: { audioOn: boolean; cameraOn: boolean; screenSharing: boolean };
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
  cameraMenuItems?: { label: string; onSelect: () => void }[];
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
  devices: { deviceId: string; label: string }[];
  selectedDeviceId?: string;
  onSelectDevice: (deviceId: string) => void;
  permission: 'prompt' | 'granted' | 'denied' | 'unavailable';
  extraItems?: { label: string; onSelect: () => void }[];
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
  screenShare: { on: boolean; disabledReason?: string; onToggle: () => void };
  onOpenPeople: () => void;
  peopleOpen?: boolean;
  onOpenSettings: () => void;
  extras?: ReactNode;
  onPopOut: () => void;
  onLeave: () => void;
  error?: { message: string; onRetry: () => void; title?: string; retryLabel?: string };
  onDismiss?: () => void;
  compact: boolean;
  'data-testid'?: string;
}

/** The call phase as the dock's (null = draw nothing: no call, or a ring the toast answers). */
export const DOCK_PHASE: Record<ConversationCallPhase, ConversationCallDockProps['phase'] | null> = {
  idle: null,
  ringing: null,
  calling: 'calling',
  connecting: 'connecting',
  live: 'active',
  reconnecting: 'reconnecting',
  ended: 'ended',
  failed: 'error',
};

const noop = () => undefined;

/**
 * The dock for this call, or null while there is nothing to dock (idle, or a
 * ring — the toast answers those).
 */
export function conversationCallDockProps(
  s: ConversationCallDockState,
  ui: ConversationCallDockUi,
): ConversationCallDockProps | null {
  const phase = DOCK_PHASE[s.phase];
  if (!phase) return null;
  const inCall = (s.call?.participants ?? []).filter((p) => p.state === 'in-call' || p.state === 'reconnecting');
  const local = inCall.find((p) => p.isLocal) ?? null;

  const participants: ConversationCallDockParticipant[] = inCall.map((p) => {
    const camera = ui.tile(p);
    const base: ConversationCallDockParticipant = {
      id: p.id,
      userId: p.id,
      displayName: p.displayName,
      ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}),
      isMuted: !p.audioOn,
      isLocal: p.isLocal,
      ...(camera !== undefined ? { videoElement: camera } : {}),
      cameraOn: p.cameraOn,
      audioOn: p.audioOn,
      screenSharing: p.screenSharing,
      presenting: false,
      connection: p.state === 'reconnecting' ? 'reconnecting' : 'connected',
    };
    const screen = ui.screenTile?.(p);
    if (screen === undefined) return base;
    // The screen goes IN the sharer's tile; the sharer's voice rides their
    // camera stream, so a remote camera element becomes the tile's audio sink.
    // A local preview is muted — nothing to keep playing.
    return {
      ...base,
      videoElement: screen,
      cameraOn: true,
      screenSharing: true,
      ...(!p.isLocal && camera !== undefined ? { audioElement: camera } : {}),
    };
  });

  const remoteSharer = inCall.find((p) => !p.isLocal && p.screenSharing) ?? null;
  const activeSpeaker = ui.activeSpeakerId !== undefined ? ui.activeSpeakerId : s.activeSpeakerId;
  // Your own tile never wears the speaking ring.
  const otherSpeaker = activeSpeaker && activeSpeaker !== local?.id ? activeSpeaker : null;
  const { prefs, set, list } = s.devices;
  const timed = phase === 'active' || phase === 'reconnecting';

  return {
    title: ui.title,
    participantCount: s.call?.participantCount ?? inCall.length,
    elapsedMs: timed ? s.elapsedMs : null,
    phase,
    ...(phase === 'calling' && s.callingTo ? { callingTo: s.callingTo } : {}),
    participants,
    localParticipantId: local?.id ?? '',
    activeSpeakerId: otherSpeaker,
    mic: {
      on: s.self.audioOn,
      onToggle: s.toggleMic,
      devices: list.microphones,
      ...(prefs.microphoneId ? { selectedDeviceId: prefs.microphoneId } : {}),
      // Saved for the next join; a live microphone swap is the host's call.
      onSelectDevice: (id: string) => set({ ...prefs, microphoneId: id }),
      permission: list.permission.microphone,
    },
    camera: {
      on: s.self.cameraOn,
      onToggle: s.toggleCamera,
      devices: list.cameras,
      ...(prefs.cameraId ? { selectedDeviceId: prefs.cameraId } : {}),
      onSelectDevice: (id: string) => set({ ...prefs, cameraId: id }),
      permission: list.permission.camera,
      ...(ui.cameraMenuItems && ui.cameraMenuItems.length > 0 ? { extraItems: ui.cameraMenuItems } : {}),
    },
    screenShare: {
      on: s.self.screenSharing,
      ...(remoteSharer && !s.self.screenSharing ? { disabledReason: `${remoteSharer.displayName} is sharing` } : {}),
      onToggle: s.toggleScreenShare,
    },
    onOpenPeople: ui.onOpenPeople,
    ...(ui.peopleOpen !== undefined ? { peopleOpen: ui.peopleOpen } : {}),
    onOpenSettings: ui.onOpenSettings,
    ...(ui.extras !== undefined ? { extras: ui.extras } : {}),
    onPopOut: ui.onPopOut ?? noop,
    onLeave: () => { void s.leave(); },
    ...(phase === 'error'
      ? {
          error: {
            // The transport could not recover (the SFU went away or refused
            // us): nothing on the call is live any more, and Rejoin starts a
            // fresh session in the same call.
            title: 'Lost the call',
            message: s.error?.message || 'the connection to the call service dropped and did not come back',
            retryLabel: 'Rejoin',
            onRetry: () => { void s.rejoin(); },
          },
          onDismiss: () => { void s.leave(); },
        }
      : {}),
    ...(phase === 'ended' ? { onDismiss: () => { void s.leave(); } } : {}),
    compact: ui.compact ?? false,
    ...(ui['data-testid'] ? { 'data-testid': ui['data-testid'] } : {}),
  };
}
