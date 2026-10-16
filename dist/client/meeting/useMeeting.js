"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.useMeeting = useMeeting;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("../GatewaySocketProvider");
const lobby_1 = require("../../meeting/lobby");
const reducer_1 = require("./reducer");
function noopSend() { }
function inertOnMessage() {
    return () => { };
}
function useMeeting(meetingId, opts = {}) {
    const gatewayCtx = (0, GatewaySocketProvider_1.useGatewayOptional)();
    const sessionEpoch = gatewayCtx?.sessionEpoch;
    const send = opts.socket?.send ?? gatewayCtx?.send ?? noopSend;
    const onMessage = opts.socket?.onMessage ?? gatewayCtx?.onMessage ?? inertOnMessage;
    const enabled = opts.enabled !== false && !!meetingId;
    const [state, dispatch] = (0, react_1.useReducer)(reducer_1.meetingReducer, reducer_1.INITIAL_MEETING_STATE);
    // `send` through a ref: a caller that builds its socket object inline
    // hands a new function every render, and keying the subscription on that
    // identity would resubscribe (and reset) forever. Reconnects are followed
    // through `sessionEpoch` instead.
    const sendRef = (0, react_1.useRef)(send);
    sendRef.current = send;
    const displayNameRef = (0, react_1.useRef)(opts.displayName);
    displayNameRef.current = opts.displayName;
    // Inbound frames. Registered before the subscribe below so the snapshot
    // cannot arrive before anyone listens.
    const [clockOffsetMs, setClockOffsetMs] = (0, react_1.useState)(0);
    (0, react_1.useEffect)(() => {
        return onMessage((msg) => {
            if (msg.type !== 'meeting')
                return;
            const at = typeof msg.timestamp === 'string' ? Date.parse(msg.timestamp) : NaN;
            if (Number.isFinite(at)) {
                const offset = at - Date.now();
                setClockOffsetMs((prev) => (Math.abs(prev - offset) > 250 ? offset : prev));
            }
            dispatch({ kind: 'frame', frame: msg });
        });
        // An inline socket re-registers each render; that only swaps a listener.
    }, [onMessage]);
    // Subscribe per meeting, and again after every reconnect (sessionEpoch).
    (0, react_1.useEffect)(() => {
        dispatch({ kind: 'reset', meetingId: enabled ? meetingId : null });
        if (!enabled || !meetingId)
            return;
        sendRef.current({ service: 'meeting', action: 'subscribe', meetingId });
        return () => {
            sendRef.current({ service: 'meeting', action: 'unsubscribe', meetingId });
        };
    }, [enabled, meetingId, sessionEpoch]);
    const act = (0, react_1.useCallback)((action, extra = {}) => {
        if (!enabled || !meetingId)
            return;
        sendRef.current({ service: 'meeting', action, meetingId, ...extra });
    }, [enabled, meetingId]);
    const selfId = state.you.userId;
    const myHandPosition = (0, reducer_1.handPosition)(state.hands, selfId);
    const raiseHand = (0, react_1.useCallback)(() => act('hand.raise', displayNameRef.current ? { displayName: displayNameRef.current } : {}), [act]);
    const lowerHand = (0, react_1.useCallback)((userId) => act('hand.lower', userId ? { userId } : {}), [act]);
    const toggleHand = (0, react_1.useCallback)(() => (myHandPosition ? lowerHand() : raiseHand()), [myHandPosition, lowerHand, raiseHand]);
    const lowerAllHands = (0, react_1.useCallback)(() => act('hand.lowerAll'), [act]);
    const configureBreakouts = (0, react_1.useCallback)((rooms, o = {}) => act('breakout.configure', {
        rooms,
        ...(o.mode ? { mode: o.mode } : {}),
        ...(typeof o.allowReturnToMain === 'boolean' ? { allowReturnToMain: o.allowReturnToMain } : {}),
    }), [act]);
    const addRoom = (0, react_1.useCallback)((o = {}) => act('breakout.addRoom', {
        ...(o.id ? { id: o.id } : {}),
        ...(typeof o.name === 'string' ? { name: o.name } : {}),
    }), [act]);
    const renameRoom = (0, react_1.useCallback)((roomId, name) => act('breakout.rename', { roomId, name }), [act]);
    const assign = (0, react_1.useCallback)((assignments) => act('breakout.assign', { assignments }), [act]);
    const autoAssign = (0, react_1.useCallback)((userIds) => act('breakout.autoAssign', { userIds }), [act]);
    const openRooms = (0, react_1.useCallback)((roomIds) => act('breakout.open', roomIds ? { roomIds } : {}), [act]);
    const closeRooms = (0, react_1.useCallback)((roomIds, o = {}) => act('breakout.close', { ...(roomIds ? { roomIds } : {}), ...(o.immediate ? { immediate: true } : {}) }), [act]);
    const setTimer = (0, react_1.useCallback)((durationMs) => act('breakout.timer', { durationMs }), [act]);
    const broadcast = (0, react_1.useCallback)((message) => act('breakout.broadcast', { message, ...(displayNameRef.current ? { displayName: displayNameRef.current } : {}) }), [act]);
    const joinRoom = (0, react_1.useCallback)((roomId) => act('breakout.join', { roomId }), [act]);
    const returnToMain = (0, react_1.useCallback)(() => act('breakout.leave'), [act]);
    const endBreakouts = (0, react_1.useCallback)((o = {}) => act('breakout.end', o.immediate ? { immediate: true } : {}), [act]);
    const dismissAnnouncement = (0, react_1.useCallback)(() => dispatch({ kind: 'dismissAnnouncement' }), []);
    const clearError = (0, react_1.useCallback)(() => dispatch({ kind: 'clearError' }), []);
    const myRoomId = (0, lobby_1.breakoutRoomFor)(state.breakout, selfId);
    const myRoom = (0, react_1.useMemo)(() => (myRoomId ? state.breakout.rooms.find((r) => r.id === myRoomId) ?? null : null), [myRoomId, state.breakout.rooms]);
    const activeLobby = enabled && meetingId ? (0, lobby_1.activeMeetingLobby)(meetingId, state.breakout, selfId) : null;
    const activeChat = enabled && meetingId ? (0, lobby_1.activeMeetingChat)(meetingId, state.breakout, selfId) : null;
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
//# sourceMappingURL=useMeeting.js.map