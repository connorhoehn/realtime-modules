"use strict";
// realtime-modules/src/client/meeting/useFollowMeetingLobby.ts
//
// useFollowMeetingLobby(activeLobby, opts) — keep a participant's media in the
// lobby the meeting says they belong in. When `useMeeting().activeLobby`
// moves (a breakout opens, you are reassigned, you return to the main
// meeting, the rooms close), this leaves the current call and joins the new
// lobby. Every app would otherwise write this glue by hand, and the easy
// version double-joins, joins while still leaving, or yanks someone out of an
// unrelated call.
//
// Rules:
//   - Moves only while you are IN the meeting's media (`currentLobby` is the
//     meeting's lobby or one of its breakout lobbies). Not in a call → nothing
//     happens; joining the meeting in the first place is the app's choice.
//   - One move at a time: leave() settles before join() starts, and a move
//     never overlaps another. A target that changes mid-move is honoured once
//     the move settles (latest wins); intermediate targets are skipped.
//   - Bursts are debounced (`debounceMs`, default 300) so "close rooms, then
//     reopen" does not bounce media through the main meeting.
//   - A failed leave/join stops following and is reported in `error` until the
//     next target change.
//   - Unmounting, or `enabled` going false, mid-move stops after the leave:
//     the join never runs (0.122.1).
Object.defineProperty(exports, "__esModule", { value: true });
exports.meetingOfLobby = meetingOfLobby;
exports.useFollowMeetingLobby = useFollowMeetingLobby;
const react_1 = require("react");
const lobby_1 = require("../../meeting/lobby");
/** The meeting a lobby belongs to: itself, or the meeting of its breakout. */
function meetingOfLobby(lobby) {
    return (0, lobby_1.parseBreakoutLobby)(lobby)?.meetingId ?? lobby;
}
function useFollowMeetingLobby(activeLobby, opts) {
    const { currentLobby, debounceMs = 300, enabled = true } = opts;
    const [moving, setMoving] = (0, react_1.useState)(false);
    const [target, setTarget] = (0, react_1.useState)(null);
    const [error, setError] = (0, react_1.useState)(null);
    const leaveRef = (0, react_1.useRef)(opts.leave);
    const joinRef = (0, react_1.useRef)(opts.join);
    leaveRef.current = opts.leave;
    joinRef.current = opts.join;
    const wantRef = (0, react_1.useRef)(activeLobby);
    const currentRef = (0, react_1.useRef)(currentLobby);
    /** Where our own last completed join put the media, until the host's currentLobby catches up. */
    const landedRef = (0, react_1.useRef)(null);
    /** The host's currentLobby when we landed; any change to it means the host has caught up (or overridden us). */
    const landedFromRef = (0, react_1.useRef)(null);
    const runningRef = (0, react_1.useRef)(false);
    const failedRef = (0, react_1.useRef)(false);
    const aliveRef = (0, react_1.useRef)(true);
    const enabledRef = (0, react_1.useRef)(enabled);
    enabledRef.current = enabled;
    (0, react_1.useEffect)(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
    }, []);
    (0, react_1.useEffect)(() => {
        currentRef.current = currentLobby;
        // The host reported a new lobby since our last join: trust it from now on.
        if (landedRef.current !== null && currentLobby !== landedFromRef.current)
            landedRef.current = null;
    }, [currentLobby]);
    const where = () => landedRef.current ?? currentRef.current;
    const run = (0, react_1.useCallback)(async () => {
        if (runningRef.current)
            return; // the running loop re-reads the latest target
        runningRef.current = true;
        try {
            for (;;) {
                // Unmounted (the user left the page) or held: never start a move.
                if (!aliveRef.current || !enabledRef.current)
                    break;
                const want = wantRef.current;
                const here = where();
                if (!want || !here || want === here || failedRef.current)
                    break;
                if (meetingOfLobby(want) !== meetingOfLobby(here))
                    break;
                if (aliveRef.current) {
                    setMoving(true);
                    setTarget(want);
                }
                try {
                    await leaveRef.current();
                    // Re-check after the leave settles: joining a call for
                    // someone who has gone, or who paused following, would put
                    // them back in a meeting they walked away from.
                    if (!aliveRef.current || !enabledRef.current)
                        break;
                    await joinRef.current(want);
                    landedFromRef.current = currentRef.current;
                    landedRef.current = want;
                }
                catch (err) {
                    failedRef.current = true;
                    if (aliveRef.current)
                        setError(err);
                    break;
                }
            }
        }
        finally {
            runningRef.current = false;
            if (aliveRef.current) {
                setMoving(false);
                setTarget(null);
            }
        }
    }, []);
    (0, react_1.useEffect)(() => {
        if (wantRef.current !== activeLobby) {
            wantRef.current = activeLobby;
            failedRef.current = false;
            setError(null);
        }
        if (!enabled || !activeLobby)
            return undefined;
        const here = where();
        if (!here || here === activeLobby)
            return undefined;
        if (meetingOfLobby(activeLobby) !== meetingOfLobby(here))
            return undefined;
        const t = setTimeout(() => { void run(); }, Math.max(0, debounceMs));
        return () => clearTimeout(t);
    }, [activeLobby, currentLobby, enabled, debounceMs, run]);
    return { moving, target, error };
}
//# sourceMappingURL=useFollowMeetingLobby.js.map