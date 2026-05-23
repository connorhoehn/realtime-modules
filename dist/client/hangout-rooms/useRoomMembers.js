"use strict";
// realtime-modules/src/client/hangout-rooms/useRoomMembers.ts
//
// useRoomMembers(slug) — manage ACL for a private room.
//
// Responsibilities:
//   - REST `GET /api/rooms/:slug/members` on mount (and on slug change)
//   - Optional WS adapter for `room.member-joined` / `room.member-left`
//     events — when an event for this slug arrives, refetch the list
//     (the membership row may include audit fields we don't want to
//     reconstruct client-side)
//   - Imperative `addMember(userId, role)` and `removeMember(userId)`
//     with optimistic local-state updates
//   - AbortController-safe cancellation on unmount + slug change
//
// Config resolution mirrors useHangoutRooms: opts.baseUrl /
// opts.getAuthToken win, then fall back to LVSProvider context.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useRoomMembers = useRoomMembers;
const react_1 = require("react");
const LVSProvider_1 = require("../video/LVSProvider");
const api_1 = require("./api");
/**
 * Fetch + manage members for a private room. See module docstring for
 * full behavior. Idle when `slug` is null (returns empty list,
 * isLoading=false).
 */
function useRoomMembers(slug, opts = {}) {
    const ctx = (0, LVSProvider_1.useSafeLVSContext)();
    const baseUrl = opts.baseUrl ?? ctx?.baseUrl ?? '';
    const getAuthToken = opts.getAuthToken ?? ctx?.getAuthToken;
    const [members, setMembers] = (0, react_1.useState)([]);
    const [isLoading, setIsLoading] = (0, react_1.useState)(!!slug);
    const [error, setError] = (0, react_1.useState)(null);
    // Stable refs so action callbacks don't churn identity per render.
    const baseUrlRef = (0, react_1.useRef)(baseUrl);
    baseUrlRef.current = baseUrl;
    const getAuthTokenRef = (0, react_1.useRef)(getAuthToken);
    getAuthTokenRef.current = getAuthToken;
    const slugRef = (0, react_1.useRef)(slug);
    slugRef.current = slug;
    const abortRef = (0, react_1.useRef)(null);
    const mountedRef = (0, react_1.useRef)(true);
    const buildApiOptions = (0, react_1.useCallback)((signal) => ({
        baseUrl: baseUrlRef.current,
        getAuthToken: getAuthTokenRef.current,
        signal,
    }), []);
    const refetch = (0, react_1.useCallback)(async () => {
        const currentSlug = slugRef.current;
        if (!currentSlug) {
            setMembers([]);
            setIsLoading(false);
            return;
        }
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        setIsLoading(true);
        setError(null);
        try {
            const list = await (0, api_1.listMembers)(buildApiOptions(ac.signal), currentSlug);
            if (!ac.signal.aborted && mountedRef.current) {
                setMembers(list);
            }
        }
        catch (e) {
            if (e?.name === 'AbortError')
                return;
            if (!mountedRef.current)
                return;
            setError(e instanceof Error ? e : new Error(String(e)));
        }
        finally {
            if (mountedRef.current && !ac.signal.aborted)
                setIsLoading(false);
        }
    }, [buildApiOptions]);
    // ---- Fetch on slug change -------------------------------------------------
    (0, react_1.useEffect)(() => {
        if (!slug) {
            setMembers([]);
            setIsLoading(false);
            setError(null);
            return;
        }
        void refetch();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slug, baseUrl]);
    // ---- Mount/unmount lifecycle ----------------------------------------------
    (0, react_1.useEffect)(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            abortRef.current?.abort();
        };
    }, []);
    // ---- WS adapter: refetch on member-joined / member-left for this slug -----
    (0, react_1.useEffect)(() => {
        if (!opts.ws)
            return;
        if (!slug)
            return;
        const unsubscribe = opts.ws((evt) => {
            if (!mountedRef.current)
                return;
            if (evt.slug !== slug)
                return;
            // Refetch to pick up server-canonical row shape (addedAt etc.).
            void refetch();
        });
        return unsubscribe;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opts.ws, slug]);
    // ---- Actions --------------------------------------------------------------
    const addMember = (0, react_1.useCallback)(async (userId, role = 'member') => {
        const currentSlug = slugRef.current;
        if (!currentSlug) {
            throw new Error('useRoomMembers: cannot addMember without an active slug');
        }
        const member = await (0, api_1.addMember)(buildApiOptions(), currentSlug, userId, role);
        if (mountedRef.current) {
            setMembers((prev) => {
                // Idempotent — replace existing row if userId already present.
                const idx = prev.findIndex((m) => m.userId === member.userId);
                if (idx === -1)
                    return [...prev, member];
                const next = [...prev];
                next[idx] = member;
                return next;
            });
        }
        return member;
    }, [buildApiOptions]);
    const removeMember = (0, react_1.useCallback)(async (userId) => {
        const currentSlug = slugRef.current;
        if (!currentSlug) {
            throw new Error('useRoomMembers: cannot removeMember without an active slug');
        }
        await (0, api_1.removeMember)(buildApiOptions(), currentSlug, userId);
        if (mountedRef.current) {
            setMembers((prev) => prev.filter((m) => m.userId !== userId));
        }
    }, [buildApiOptions]);
    return (0, react_1.useMemo)(() => ({ members, isLoading, error, addMember, removeMember, refetch }), [members, isLoading, error, addMember, removeMember, refetch]);
}
//# sourceMappingURL=useRoomMembers.js.map