"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DOCK_PHASE = void 0;
exports.conversationCallDockProps = conversationCallDockProps;
/** The call phase as the dock's (null = draw nothing: no call, or a ring the toast answers). */
exports.DOCK_PHASE = {
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
function conversationCallDockProps(s, ui) {
    const phase = exports.DOCK_PHASE[s.phase];
    if (!phase)
        return null;
    const inCall = (s.call?.participants ?? []).filter((p) => p.state === 'in-call' || p.state === 'reconnecting');
    const local = inCall.find((p) => p.isLocal) ?? null;
    const participants = inCall.map((p) => {
        const camera = ui.tile(p);
        const base = {
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
        if (screen === undefined)
            return base;
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
            onSelectDevice: (id) => set({ ...prefs, microphoneId: id }),
            permission: list.permission.microphone,
        },
        camera: {
            on: s.self.cameraOn,
            onToggle: s.toggleCamera,
            devices: list.cameras,
            ...(prefs.cameraId ? { selectedDeviceId: prefs.cameraId } : {}),
            onSelectDevice: (id) => set({ ...prefs, cameraId: id }),
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
//# sourceMappingURL=conversationCallDockProps.js.map