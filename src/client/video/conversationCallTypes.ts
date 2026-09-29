// Types shared by the conversation-call hooks (useConversationCall,
// useIncomingConversationCalls, conversationCallDockProps). A conversation
// call is the DM / room call docked above a chat composer: rung over the
// gateway's `call` service, carried by a platform-api video session, with
// media over LVS. docs/design/conversation-call-port.md.

import type { DocumentCallGateway } from './documentCallGateway';

/** The gateway slice the hooks use — the same one the document-call hooks
 *  take (`send` or `sendMessage`, `onMessage`, optional `connectionState` /
 *  `sessionEpoch`). Omit it to use the surrounding GatewaySocketProvider. */
export type ConversationCallGateway = DocumentCallGateway;

/** The microphone, camera and speaker this person wants calls to use. Same
 *  shape as ui-components' `DevicePreferences`, stored per browser. */
export interface DevicePreferences {
  microphoneId?: string;
  cameraId?: string;
  speakerId?: string;
}

/**
 * Where a conversation call is.
 *
 *   idle         nothing — no call, no ring for this lobby
 *   calling      you rang someone and nobody has answered yet
 *   ringing      someone is ringing you into this lobby (see `incoming`)
 *   connecting   creating / joining the session, or media negotiating
 *   live         in the call with media up
 *   reconnecting the gateway or the media transport is recovering
 *   ended        the call just ended (held briefly, then idle)
 *   failed       the join or the transport failed; `rejoin()` tries again
 */
export type ConversationCallPhase =
  | 'idle'
  | 'calling'
  | 'ringing'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'ended'
  | 'failed';

/** One person on (or being rung into) the call. */
export interface ConversationCallParticipant {
  /** Tile key: the media participant id when known, else the userId. The
   *  dock matches `localParticipantId` and `activeSpeakerId` against it. */
  id: string;
  userId: string;
  displayName: string;
  avatarUrl?: string;
  isLocal: boolean;
  /** `ringing` / `declined` / `busy` are invitees who are not in the call. */
  state: 'in-call' | 'reconnecting' | 'ringing' | 'declined' | 'busy';
  audioOn: boolean;
  cameraOn: boolean;
  screenSharing: boolean;
  /** The SFU participant id, once they have joined media. */
  participantId: string | null;
  /** Camera + microphone stream (null before media, or for an invitee). */
  stream: MediaStream | null;
  /** Their screen, while sharing. */
  screenStream: MediaStream | null;
}

/** The call this conversation is in. */
export interface ConversationCall {
  callId: string;
  lobbyName: string;
  /** The chat channel it belongs to, when known. */
  channel: string | null;
  /** When someone first answered (or you joined someone's call). Null while ringing. */
  startedAt: number | null;
  /** Who started the call. */
  host: string | null;
  /** You, then everyone in the call, then invitees still ringing / who said no. */
  participants: ConversationCallParticipant[];
  /** Distinct people in the call, you included — an accepted callee counts
   *  before their media arrives, so the dock never reads "1 person" between
   *  the accept and the first frame. */
  participantCount: number;
  audioOnly: boolean;
}

/** A ring addressed to you. */
export interface IncomingConversationCall {
  callId: string;
  lobbyName: string;
  channel: string | null;
  callerId: string;
  callerName: string;
  /** The invite named you (not an ambient broadcast). */
  targeted: boolean;
  /** `knock` = someone outside a call you are in asks to be let in. */
  kind: 'invite' | 'knock';
  audioOnly: boolean;
  receivedAt: number;
}

export type ConversationCallDeclineReason = 'not-now' | 'busy';

/** What the client-side lifecycle callbacks receive. */
export interface ConversationCallEvent {
  callId: string;
  lobbyName: string;
  channel: string | null;
  /** The other people, by userId (never you). */
  peerUserIds: string[];
}
