// realtime-modules/src/client/meeting/useMeeting.ts
//
// useMeeting(meetingId, opts?) — raised hands and breakout rooms for the call
// a page is already in. The meetingId IS the main call's lobby name, so
// `activeLobby` (the lobby this user's media should be in right now) can be
// handed straight to useConversationCall / useLVSHangout; when it changes,
// leave the old lobby and join the new one.
//
// Outbound frames: { service: 'meeting', action, meetingId, ... } — see
// src/meeting/types.ts. Inbound: { type: 'meeting', action, meetingId, data }.
//
// Socket: like useReactions, pass `socket` to bypass GatewaySocketProvider;
// with neither a socket nor a provider the hook is inert.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
// Type-only (erased at build): every frame this hook sends is checked against
// the event-catalog declaration, meeting@1.1.0 (0.133.0).
import type { ClientFramePayload, MeetingOutboundFrame } from '@connorhoehn/event-catalog/client-frames';
import { useGatewayOptional } from '../GatewaySocketProvider';
import type { GatewayMessage } from '../types';
import type { BreakoutMode, BreakoutRoom, BreakoutState, RaisedHand } from '../../meeting/types';
import { activeMeetingChat, activeMeetingLobby, breakoutChannel, breakoutRoomFor } from '../../meeting/lobby';
import {
    INITIAL_MEETING_STATE,
    handPosition,
    meetingReducer,
    type MeetingClientError,
    type MeetingClientState,
} from './reducer';

export interface UseMeetingOptions {
    /** Send/receive handles when the caller owns the socket (see useReactions). */
    socket?: {
        send: (message: Record<string, unknown>) => void;
        onMessage: (handler: (msg: GatewayMessage) => void) => () => void;
    };
    /**
     * Shown on your raised hand when the server's auth context carries no
     * display name. The server prefers its own.
     */
    displayName?: string;
    /** Set false to hold the subscription (e.g. before the call is live). Default true. */
    enabled?: boolean;
    /**
     * The call's own chat channel when the host names it something other than
     * the lobby (e.g. `orgiq:huddle:<callId>`) (0.134.0, lane L3). Given it,
     * `activeChat` is this channel outside a room and
     * `breakoutChannel(chatChannel, roomId)` inside one. Absent, `activeChat`
     * is `meetingChatChannel` as before.
     */
    chatChannel?: string;
}

export interface BreakoutRoomDraft {
    id?: string;
    name: string;
    members?: string[];
}

export interface UseMeetingResult {
    state: MeetingClientState;
    ready: boolean;
    error: MeetingClientError | null;
    clearError(): void;
    /** Whether the server treats you as an organizer of this meeting. */
    isOrganizer: boolean;

    // hands
    hands: RaisedHand[];
    /** Your 1-based place in the queue, or null. */
    myHandPosition: number | null;
    raiseHand(): void;
    /** Lower your own hand, or (organizer) someone else's. */
    lowerHand(userId?: string): void;
    toggleHand(): void;
    lowerAllHands(): void;

    // breakouts
    breakout: BreakoutState;
    /** The open room you belong in, or null for the main meeting. */
    myRoom: BreakoutRoom | null;
    /** The lobby your media should be in: your room's, or the meeting's. */
    activeLobby: string | null;
    /**
     * The chat channel this user should read right now: their open room's, or
     * the meeting's (0.126.0). Hand it to `useChat`; it moves with `activeLobby`.
     * With `opts.chatChannel`, it is that channel or its breakout suffix.
     */
    activeChat: string | null;
    /**
     * Server clock minus this device's clock, in ms (0.129.0), from the
     * `timestamp` every meeting frame carries. Count down to `breakout.endsAt`
     * from `Date.now() + clockOffsetMs`, or a laptop whose clock is 40 s off
     * shows a timer 40 s off. Network latency makes it a little low; it
     * updates when it moves by more than a quarter second.
     */
    clockOffsetMs: number;
    configureBreakouts(rooms: BreakoutRoomDraft[], opts?: { mode?: BreakoutMode; allowReturnToMain?: boolean }): void;
    /** Adds one closed room in any phase (default name `Room N`); open it with `openRooms([id])`. */
    addRoom(opts?: { id?: string; name?: string }): void;
    /** Renames a room in any phase; 1–80 characters after trimming. */
    renameRoom(roomId: string, name: string): void;
    /** userId → roomId, or null to unassign. */
    assign(assignments: Record<string, string | null>): void;
    autoAssign(userIds: string[]): void;
    openRooms(roomIds?: string[]): void;
    /**
     * Close some rooms (by id, at once) or all of them. With a server
     * `closingGraceMs`, closing all starts the countdown (`breakout.closing`);
     * `{ immediate: true }` or a second call closes at once.
     */
    closeRooms(roomIds?: string[], opts?: { immediate?: boolean }): void;
    /** Minutes are the common unit in the UI; pass null to clear. */
    setTimer(durationMs: number | null): void;
    broadcast(message: string): void;
    joinRoom(roomId: string): void;
    returnToMain(): void;
    /** End the session; the same countdown and `immediate` as `closeRooms()`. */
    endBreakouts(opts?: { immediate?: boolean }): void;
    dismissAnnouncement(): void;
}

/** A meeting verb the catalog declares. */
type MeetingVerb = MeetingOutboundFrame['action'];
/**
 * The fields a verb carries beyond the envelope, from its catalog frame. The
 * generated frames have an index signature (`[key: string]: unknown`), which
 * `Omit` would turn into "any string key": the `as` clause drops it and keeps
 * the named fields, so a misspelt or mistyped field fails to compile.
 */
type VerbFields<A extends MeetingVerb> = {
    [K in keyof Extract<MeetingOutboundFrame, { action: A }> as string extends K ? never
        : K extends 'service' | 'action' | 'meetingId' | 'channel' ? never : K]?: Extract<MeetingOutboundFrame, { action: A }>[K];
};

function noopSend(): void {}
function inertOnMessage(): () => void {
    return () => {};
}

export function useMeeting(meetingId: string | null, opts: UseMeetingOptions = {}): UseMeetingResult {
    const gatewayCtx = useGatewayOptional();
    const sessionEpoch = gatewayCtx?.sessionEpoch;
    const send = opts.socket?.send ?? gatewayCtx?.send ?? noopSend;
    const onMessage = opts.socket?.onMessage ?? gatewayCtx?.onMessage ?? inertOnMessage;
    const enabled = opts.enabled !== false && !!meetingId;

    const [state, dispatch] = useReducer(meetingReducer, INITIAL_MEETING_STATE);
    // `send` through a ref: a caller that builds its socket object inline
    // hands a new function every render, and keying the subscription on that
    // identity would resubscribe (and reset) forever. Reconnects are followed
    // through `sessionEpoch` instead.
    const sendRef = useRef(send);
    sendRef.current = send;
    const displayNameRef = useRef(opts.displayName);
    displayNameRef.current = opts.displayName;

    // Inbound frames. Registered before the subscribe below so the snapshot
    // cannot arrive before anyone listens.
    const [clockOffsetMs, setClockOffsetMs] = useState(0);
    useEffect(() => {
        return onMessage((msg: GatewayMessage) => {
            if (msg.type !== 'meeting') return;
            const at = typeof msg.timestamp === 'string' ? Date.parse(msg.timestamp) : NaN;
            if (Number.isFinite(at)) {
                const offset = at - Date.now();
                setClockOffsetMs((prev) => (Math.abs(prev - offset) > 250 ? offset : prev));
            }
            dispatch({ kind: 'frame', frame: msg as Record<string, unknown> });
        });
        // An inline socket re-registers each render; that only swaps a listener.
    }, [onMessage]);

    // Subscribe per meeting, and again after every reconnect (sessionEpoch).
    useEffect(() => {
        dispatch({ kind: 'reset', meetingId: enabled ? meetingId : null });
        if (!enabled || !meetingId) return;
        sendRef.current({ service: 'meeting', action: 'subscribe', meetingId } satisfies ClientFramePayload<'client.meeting.subscribe'>);
        return () => {
            sendRef.current({ service: 'meeting', action: 'unsubscribe', meetingId } satisfies ClientFramePayload<'client.meeting.unsubscribe'>);
        };
    }, [enabled, meetingId, sessionEpoch]);

    const act = useCallback(
        <A extends MeetingVerb>(action: A, extra: VerbFields<A> = {}) => {
            if (!enabled || !meetingId) return;
            sendRef.current({ service: 'meeting', action, meetingId, ...extra });
        },
        [enabled, meetingId],
    );

    const selfId = state.you.userId;
    const myHandPosition = handPosition(state.hands, selfId);

    const raiseHand = useCallback(() => act('hand.raise', displayNameRef.current ? { displayName: displayNameRef.current } : {}), [act]);
    const lowerHand = useCallback((userId?: string) => act('hand.lower', userId ? { userId } : {}), [act]);
    const toggleHand = useCallback(() => (myHandPosition ? lowerHand() : raiseHand()), [myHandPosition, lowerHand, raiseHand]);
    const lowerAllHands = useCallback(() => act('hand.lowerAll'), [act]);

    const configureBreakouts = useCallback<UseMeetingResult['configureBreakouts']>(
        (rooms, o = {}) => act('breakout.configure', {
            // Copied into plain objects: an interface has no implicit index
            // signature, and the catalog's room draft allows extra keys.
            rooms: rooms.map((r) => ({ ...r })),
            ...(o.mode ? { mode: o.mode } : {}),
            ...(typeof o.allowReturnToMain === 'boolean' ? { allowReturnToMain: o.allowReturnToMain } : {}),
        }),
        [act],
    );
    const addRoom = useCallback<UseMeetingResult['addRoom']>(
        (o = {}) => act('breakout.addRoom', {
            ...(o.id ? { id: o.id } : {}),
            ...(typeof o.name === 'string' ? { name: o.name } : {}),
        }),
        [act],
    );
    const renameRoom = useCallback((roomId: string, name: string) => act('breakout.rename', { roomId, name }), [act]);
    const assign = useCallback((assignments: Record<string, string | null>) => act('breakout.assign', { assignments }), [act]);
    const autoAssign = useCallback((userIds: string[]) => act('breakout.autoAssign', { userIds }), [act]);
    const openRooms = useCallback((roomIds?: string[]) => act('breakout.open', roomIds ? { roomIds } : {}), [act]);
    const closeRooms = useCallback(
        (roomIds?: string[], o: { immediate?: boolean } = {}) =>
            act('breakout.close', { ...(roomIds ? { roomIds } : {}), ...(o.immediate ? { immediate: true } : {}) }),
        [act],
    );
    const setTimer = useCallback((durationMs: number | null) => act('breakout.timer', { durationMs }), [act]);
    const broadcast = useCallback(
        (message: string) => act('breakout.broadcast', { message, ...(displayNameRef.current ? { displayName: displayNameRef.current } : {}) }),
        [act],
    );
    const joinRoom = useCallback((roomId: string) => act('breakout.join', { roomId }), [act]);
    const returnToMain = useCallback(() => act('breakout.leave'), [act]);
    const endBreakouts = useCallback(
        (o: { immediate?: boolean } = {}) => act('breakout.end', o.immediate ? { immediate: true } : {}),
        [act],
    );
    const dismissAnnouncement = useCallback(() => dispatch({ kind: 'dismissAnnouncement' }), []);
    const clearError = useCallback(() => dispatch({ kind: 'clearError' }), []);

    const myRoomId = breakoutRoomFor(state.breakout, selfId);
    const myRoom = useMemo(
        () => (myRoomId ? state.breakout.rooms.find((r) => r.id === myRoomId) ?? null : null),
        [myRoomId, state.breakout.rooms],
    );
    const activeLobby = enabled && meetingId ? activeMeetingLobby(meetingId, state.breakout, selfId) : null;
    const chatChannel = opts.chatChannel;
    const activeChat = !enabled || !meetingId
        ? null
        : chatChannel
            ? (myRoomId ? breakoutChannel(chatChannel, myRoomId) : chatChannel)
            : activeMeetingChat(meetingId, state.breakout, selfId);

    return {
        state,
        ready: state.ready,
        error: state.error,
        clearError,
        isOrganizer: state.you.organizer,
        hands: state.hands,
        myHandPosition,
        raiseHand,
        lowerHand,
        toggleHand,
        lowerAllHands,
        breakout: state.breakout,
        myRoom,
        activeLobby,
        activeChat,
        clockOffsetMs,
        configureBreakouts,
        addRoom,
        renameRoom,
        assign,
        autoAssign,
        openRooms,
        closeRooms,
        setTimer,
        broadcast,
        joinRoom,
        returnToMain,
        endBreakouts,
        dismissAnnouncement,
    };
}
