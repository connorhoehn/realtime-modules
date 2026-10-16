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

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseBreakoutLobby } from '../../meeting/lobby';

export interface UseFollowMeetingLobbyOptions {
    /** The lobby your media is in now (null when not in a call). */
    currentLobby: string | null;
    /** Leave the current call. May be async; awaited before join. */
    leave: () => void | Promise<void>;
    /** Join `lobby`'s call. May be async. */
    join: (lobby: string) => void | Promise<void>;
    /** Coalesce bursts of target changes. Default 300 ms. */
    debounceMs?: number;
    /** Hold following (e.g. while a pre-join dialog is open). Default true. */
    enabled?: boolean;
}

export interface UseFollowMeetingLobbyResult {
    /** A leave/join is in flight. */
    moving: boolean;
    /** Where the in-flight move is going, or null. */
    target: string | null;
    /** The last leave/join failure, cleared by the next target change. */
    error: unknown | null;
}

/** The meeting a lobby belongs to: itself, or the meeting of its breakout. */
export function meetingOfLobby(lobby: string): string {
    return parseBreakoutLobby(lobby)?.meetingId ?? lobby;
}

export function useFollowMeetingLobby(
    activeLobby: string | null,
    opts: UseFollowMeetingLobbyOptions,
): UseFollowMeetingLobbyResult {
    const { currentLobby, debounceMs = 300, enabled = true } = opts;
    const [moving, setMoving] = useState(false);
    const [target, setTarget] = useState<string | null>(null);
    const [error, setError] = useState<unknown | null>(null);

    const leaveRef = useRef(opts.leave);
    const joinRef = useRef(opts.join);
    leaveRef.current = opts.leave;
    joinRef.current = opts.join;

    const wantRef = useRef<string | null>(activeLobby);
    const currentRef = useRef<string | null>(currentLobby);
    /** Where our own last completed join put the media, until the host's currentLobby catches up. */
    const landedRef = useRef<string | null>(null);
    /** The host's currentLobby when we landed; any change to it means the host has caught up (or overridden us). */
    const landedFromRef = useRef<string | null>(null);
    const runningRef = useRef(false);
    const failedRef = useRef(false);
    const aliveRef = useRef(true);

    useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
    }, []);

    useEffect(() => {
        currentRef.current = currentLobby;
        // The host reported a new lobby since our last join: trust it from now on.
        if (landedRef.current !== null && currentLobby !== landedFromRef.current) landedRef.current = null;
    }, [currentLobby]);

    const where = () => landedRef.current ?? currentRef.current;

    const run = useCallback(async () => {
        if (runningRef.current) return; // the running loop re-reads the latest target
        runningRef.current = true;
        try {
            for (;;) {
                const want = wantRef.current;
                const here = where();
                if (!want || !here || want === here || failedRef.current) break;
                if (meetingOfLobby(want) !== meetingOfLobby(here)) break;
                if (aliveRef.current) { setMoving(true); setTarget(want); }
                try {
                    await leaveRef.current();
                    await joinRef.current(want);
                    landedFromRef.current = currentRef.current;
                    landedRef.current = want;
                } catch (err) {
                    failedRef.current = true;
                    if (aliveRef.current) setError(err);
                    break;
                }
            }
        } finally {
            runningRef.current = false;
            if (aliveRef.current) { setMoving(false); setTarget(null); }
        }
    }, []);

    useEffect(() => {
        if (wantRef.current !== activeLobby) {
            wantRef.current = activeLobby;
            failedRef.current = false;
            setError(null);
        }
        if (!enabled || !activeLobby) return undefined;
        const here = where();
        if (!here || here === activeLobby) return undefined;
        if (meetingOfLobby(activeLobby) !== meetingOfLobby(here)) return undefined;
        const t = setTimeout(() => { void run(); }, Math.max(0, debounceMs));
        return () => clearTimeout(t);
    }, [activeLobby, currentLobby, enabled, debounceMs, run]);

    return { moving, target, error };
}
