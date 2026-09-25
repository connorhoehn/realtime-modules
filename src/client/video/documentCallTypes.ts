// Types shared by the document-call hooks (useMediaDevices,
// useAudioVideoSettings, useDocumentCall, useIncomingDocumentCalls).
// realtime-examples docs/design/document-calls/SPEC.md §4.1 and §5.3.

import type {
  DocumentCallInvite,
  DocumentCallMeta,
  DocumentCallPresenting,
} from '../../call/types';

export type { DocumentCallInvite, DocumentCallMeta, DocumentCallPresenting };

/** Browser permission for one kind of device. `unavailable` = no such device
 *  (or no media API at all). */
export type MediaPermission = 'prompt' | 'granted' | 'denied' | 'unavailable';

export interface DeviceOption {
  deviceId: string;
  /** Browser label, or "Microphone 2" style when labels are hidden (no permission yet). */
  label: string;
  kind: 'audioinput' | 'videoinput' | 'audiooutput';
  groupId?: string;
  /** The browser's "default" entry. */
  isDefault?: boolean;
}

export type CallQuality = 'auto' | '720p' | '480p' | '360p';

/** Per-browser media settings (SPEC §3.3 AudioVideoSettingsForm). Stored under
 *  `call-device-preferences` — the key the app's DeviceSettingsPanel already
 *  uses; microphoneId / cameraId / speakerId keep their old meaning. */
export interface AudioVideoSettings {
  microphoneId?: string;
  speakerId?: string;
  cameraId?: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  /** Playback gain for remote audio, 0–1. Client-local. */
  volume: number;
  mirrorPreview: boolean;
  quality: CallQuality;
  frameRate: 'auto' | 30 | 15;
  /** Persist to localStorage; otherwise settings live for the session only. */
  rememberDevices: boolean;
}

export const DEFAULT_AUDIO_VIDEO_SETTINGS: AudioVideoSettings = {
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  volume: 0.65,
  mirrorPreview: true,
  quality: 'auto',
  frameRate: 'auto',
  rememberDevices: true,
};

/** The durable call record (PA `video-sessions` row, extended). */
export interface DocumentCallSession {
  sessionId: string;
  lobbyName: string;
  kind: 'document-review';
  documentId: string;
  title: string;
  documentIds: string[];
  hostUserId: string;
  media: 'video' | 'audio';
  createdBy: string;
  createdAt: number;
  endedAt?: number;
  recordingDecision: { enabled: boolean; reason: string } | null;
  /** From the SFU room, when PA reports it. */
  participantCount?: number;
}

/** The media-side facts about a participant (an LVS session member, as the
 *  consumer's media layer reports it). Kept structural so RM does not depend
 *  on lvs-react. */
export interface DocumentCallMediaMember {
  userId: string;
  participantId?: string;
  displayName?: string;
  audioOn?: boolean;
  cameraOn?: boolean;
  screenSharing?: boolean;
  /** The consumer's own member object (tracks, video element, …), passed through. */
  [k: string]: unknown;
}

export type DocumentCallParticipantState = 'in-call' | 'left' | 'reconnecting' | 'ringing' | 'missed' | 'declined';

export interface DocumentCallParticipant {
  userId: string;
  /** Last connection seen for this person ('' until they are in the call). */
  clientId: string;
  displayName: string;
  avatarUrl?: string;
  color?: string;
  state: DocumentCallParticipantState;
  audioOn: boolean;
  cameraOn: boolean;
  screenSharing: boolean;
  presenting: boolean;
  isHost: boolean;
  isSelf: boolean;
  /** Silenced locally with "Mute for me" (never sent anywhere). The consumer
   *  applies it to the person's audio element. */
  mutedForMe: boolean;
  /** Media member from the consumer's LVS session, when joined. */
  media?: DocumentCallMediaMember;
  /** Where they are in the document, from Y awareness (same document only). */
  location?: { documentId: string; sectionId: string | null; sectionTitle: string | null };
}

/** The slice of a Y-awareness participant the follow feature reads. */
export interface DocumentCallAwarenessParticipant {
  userId: string;
  displayName?: string;
  avatarUrl?: string;
  color?: string;
  documentId?: string;
  currentSectionId?: string | null;
  currentSectionTitle?: string | null;
}
