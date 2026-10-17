import { type UseLVSHangoutOptions, type UseLVSHangoutResult } from './useLVSHangout';
import { type UseMediaDevicesResult } from './useMediaDevices';
import type { ConversationCall, ConversationCallDeclineReason, ConversationCallEvent, ConversationCallGateway, ConversationCallInvitationRequest, ConversationCallInviteResult, ConversationCallPhase, DevicePreferences, IncomingConversationCall } from './conversationCallTypes';
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
export interface UseConversationCallOptions {
    /** Verbatim lobby name — never rewritten. Tenant prefixes are the caller's (`<tenant>:dm:<a>:<b>`). */
    lobbyName: string;
    /** The chat channel the call belongs to (for cards / discovery). Defaults to channelForLobby(lobbyName). */
    channel?: string | null;
    /**
     * The lobby whose LVS session your MEDIA joins (0.134.0, lane L1). Defaults
     * to `lobbyName`. A meeting's breakout hands `useMeeting().activeLobby`
     * here: when it changes mid-call the media leaves the current session and
     * joins the new lobby's, while the call itself (its `callId`, its signalling
     * on `lobbyName`, its roster) stays put — no ring, no `invite` / `accepted`
     * / `ended`, no call frame at all. Moves are serialized and the latest
     * wins; a failed join keeps the call and shows as `error` (`rejoin()` retries
     * in the current media lobby).
     */
    mediaLobby?: string | null;
    self: {
        userId: string;
        displayName: string;
        avatarUrl?: string;
    };
    /**
     * The host's directory: a person's name and picture when the call's own
     * signalling has none (a page huddle rings nobody, so its roster often
     * carries ids only) (0.136.0). Asked before a tile falls back to the id.
     */
    nameFor?: (userId: string) => {
        displayName: string;
        avatarUrl?: string;
    } | null | undefined;
    /** platform-api access — props, never env. `getIdToken` is called per request. */
    platformApi: {
        baseUrl: string;
        getIdToken: () => string | Promise<string>;
    };
    /** The gateway socket the app already holds. Defaults to the surrounding GatewaySocketProvider. */
    gateway?: ConversationCallGateway | null;
    /** Initial device preferences; the hook keeps them (see `devices`). */
    devices?: DevicePreferences;
    /** Capture intent read before start/accept/rejoin. Defaults to both on. */
    initialMedia?: {
        micOn: boolean;
        cameraOn: boolean;
    };
    /** Where device preferences persist. Default localStorage; null = memory only. */
    deviceStorage?: StorageLike | null;
    /** LVS base URL, when there is no <LVSProvider> above. */
    lvsBaseUrl?: string;
    /** platform-api recording profile for sessions this hook creates. Omitted = the server's default. */
    recordingProfile?: 'hangout' | 'broadcast' | 'dm' | 'none';
    /** Opt in when platform-api supports verified participant-to-call recording bindings. */
    bindRecordingCall?: boolean;
    /** Untrusted source hint for document lobbies. Native authority validates the
     * source and canonical lobby before acknowledging its durable association. */
    documentSourceId?: string;
    /** Someone answered (caller side) or you joined (callee side). */
    onCallStarted?(e: ConversationCallEvent & {
        startedAt: number;
    }): void;
    /** A call that had started is over for you. */
    onCallEnded?(e: ConversationCallEvent & {
        reason: string;
        durationMs: number | null;
    }): void;
    /** Nobody answered your ring (`outgoing`), or a ring to you stopped unanswered (`incoming`). */
    onCallMissed?(e: ConversationCallEvent & {
        direction: 'outgoing' | 'incoming';
    }): void;
    /** How long you ring before giving up. Default 60 s. */
    ringTimeoutMs?: number;
    /** After an accept, how long to wait for their media. Default 30 s. */
    acceptedJoinTimeoutMs?: number;
    /** How long `ended` shows before the phase returns to idle. Default 4 s. */
    endedHoldMs?: number;
    /**
     * Watch this lobby for a live call (`watch`, 0.136.0): the gateway answers
     * with a `lobby-occupancy` snapshot and pushes another whenever a call
     * starts, changes or ends, so a call started after mount is offered without
     * a refresh. Re-watched on reconnect. Default true.
     */
    discover?: boolean;
    /** Injectable for tests. */
    fetch?: typeof fetch;
    /**
     * The media hook. Default RM's useLVSHangout; a host on lvs-react passes its
     * useLVSHangout. Must be the same function on every render.
     */
    useMedia?: (opts: UseLVSHangoutOptions) => UseLVSHangoutResult;
}
export interface ConversationCallResult {
    phase: ConversationCallPhase;
    /** Independent of call/media health. Only a durable native ACK can mark this bound. */
    recordingBinding?: {
        status: 'disabled' | 'pending' | 'bound' | 'unavailable';
        callId?: string;
        error?: string;
        documentContext?: {
            tenant: 'assessment';
            sourceId: string;
            lobbyName: string;
        };
    };
    /** The call you are in — or, while idle, a live call in this lobby you could join (`rejoin()`). */
    call: ConversationCall | null;
    /** A ring for THIS lobby (the app-wide toast uses useIncomingConversationCalls). */
    incoming: IncomingConversationCall | null;
    error: {
        message: string;
        status?: number;
        code?: string;
    } | null;
    /** How the last call ended, while phase is 'ended'. */
    ended: {
        at: number;
        reason: string;
        durationMs: number | null;
    } | null;
    /** "Alice" / "Alice & Bob" while phase is 'calling'. */
    callingTo: string | null;
    /** Your own media state. */
    self: {
        audioOn: boolean;
        cameraOn: boolean;
        screenSharing: boolean;
    };
    /** The lobby your media is in, or moving to (0.134.0); null outside a call. */
    mediaLobby?: string | null;
    /** Ring these people into a new call in this lobby (none = an open call nobody is rung into). */
    start(targets: {
        userId: string;
        displayName?: string;
    }[], opts?: {
        audioOnly?: boolean;
    }): Promise<void>;
    /** Request these people into the existing live call; never creates or rejoins media. */
    inviteUsers(targets: {
        userId: string;
        displayName?: string;
    }[]): ConversationCallInviteResult;
    /** Locally requested people, separate from the authoritative in-call roster. */
    invitationRequests: ConversationCallInvitationRequest[];
    /** A correlated rejection, or an unscoped legacy gateway failure (delivery stays unconfirmed). */
    invitationError: string | null;
    /** Answer `incoming` (or a ring handed over from the app-wide toast). */
    accept(ring?: IncomingConversationCall): Promise<void>;
    decline(reason?: ConversationCallDeclineReason): void;
    /** Hang up (cancels the ring when nobody answered). While 'ended', dismisses. */
    leave(): Promise<void>;
    /** After a failure, join the same call again; while idle, join the live call in this lobby. */
    rejoin(): Promise<void>;
    toggleMic(): void;
    toggleCamera(): void;
    toggleScreenShare(): void;
    /** Members/streams, screen share, raw transport state. */
    media: UseLVSHangoutResult;
    devices: {
        prefs: DevicePreferences;
        set(next: DevicePreferences): void;
        list: UseMediaDevicesResult;
    };
    elapsedMs: number | null;
    /**
     * The loudest participant's `id`, when the host reports one. This hook does
     * not analyse audio; ConversationCallDock (ui-components) does.
     */
    activeSpeakerId: string | null;
}
/** "Alice", "Alice & Bob", "Alice, Bob & 2 others". */
export declare function callingLabel(names: string[]): string;
export declare function useConversationCall(opts: UseConversationCallOptions): ConversationCallResult;
export {};
//# sourceMappingURL=useConversationCall.d.ts.map