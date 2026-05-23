"use strict";
// realtime-modules/src/client/hangout-rooms/useHangoutRooms.ts
//
// useHangoutRooms — list + manage persistent rooms.
//
// Responsibilities:
//   - REST list (filtered to active by default) on mount
//   - Optional WS adapter for live `room.created` / `room.updated` /
//     `room.archived` events so the list stays fresh without polling
//   - Imperative `createRoom`, `archiveRoom`, `joinRoom` actions
//   - AbortController-safe: in-flight fetches are cancelled on unmount
//     and on dep changes
//
// Config resolution mirrors useLVSHangout / useLVSRecordings:
//   1. opts.baseUrl ?? LVSProvider.baseUrl ?? ''
//   2. opts.getAuthToken ?? LVSProvider.getAuthToken (required for auth)
//
// The optional `ws` adapter is intentionally minimal — a
// `subscribe(handler): () => void` shape — so apps can plug in their
// gateway WebSocket (useGateway, raw ws, etc.) without this hook
// depending on a specific WS API.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useHangoutRooms = useHangoutRooms;
const react_1 = require("react");
const LVSProvider_1 = require("../video/LVSProvider");
const api_1 = require("./api");
/**
 * List + manage persistent hangout rooms. See module docstring for
 * full behavior. Cancellation-safe; abort fetch on unmount.
 *
 * Example:
 * ```tsx
 * const { rooms, createRoom, joinRoom } = useHangoutRooms({
 *   ws: (handler) => subscribeRoomsIndex(handler),
 * });
 * ```
 */
function useHangoutRooms(opts = {}) {
    const ctx = (0, LVSProvider_1.useSafeLVSContext)();
    const baseUrl = opts.baseUrl ?? ctx?.baseUrl ?? '';
    const getAuthToken = opts.getAuthToken ?? ctx?.getAuthToken;
    const autoFetch = opts.autoFetch ?? true;
    const [rooms, setRooms] = (0, react_1.useState)([]);
    const [isLoading, setIsLoading] = (0, react_1.useState)(autoFetch);
    const [error, setError] = (0, react_1.useState)(null);
    // Stable refs so refetch / actions don't churn their identity each
    // render (callers may pass them to memoized children).
    const baseUrlRef = (0, react_1.useRef)(baseUrl);
    baseUrlRef.current = baseUrl;
    const getAuthTokenRef = (0, react_1.useRef)(getAuthToken);
    getAuthTokenRef.current = getAuthToken;
    const queryRef = (0, react_1.useRef)(opts.query);
    queryRef.current = opts.query;
    const abortRef = (0, react_1.useRef)(null);
    const mountedRef = (0, react_1.useRef)(true);
    const buildApiOptions = (0, react_1.useCallback)((signal) => ({
        baseUrl: baseUrlRef.current,
        getAuthToken: getAuthTokenRef.current,
        signal,
    }), []);
    const refetch = (0, react_1.useCallback)(async () => {
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        setIsLoading(true);
        setError(null);
        try {
            const list = await (0, api_1.listRooms)(buildApiOptions(ac.signal), queryRef.current ?? { state: 'active' });
            if (!ac.signal.aborted && mountedRef.current) {
                setRooms(list);
            }
        }
        catch (e) {
            // AbortError is the only error we silently swallow — caller-cancelled.
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
    // ---- Auto-fetch on mount + dep changes ------------------------------------
    (0, react_1.useEffect)(() => {
        if (!autoFetch) {
            setIsLoading(false);
            return;
        }
        void refetch();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoFetch, baseUrl]);
    // ---- Mount/unmount lifecycle ----------------------------------------------
    (0, react_1.useEffect)(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            abortRef.current?.abort();
        };
    }, []);
    // ---- WS adapter — merge live events into local state ----------------------
    (0, react_1.useEffect)(() => {
        if (!opts.ws)
            return;
        const unsubscribe = opts.ws((evt) => {
            if (!mountedRef.current)
                return;
            switch (evt.type) {
                case 'room.created': {
                    if (!evt.room)
                        return;
                    const room = evt.room;
                    setRooms((prev) => {
                        // Dedup by slug — if create echo arrives after our local
                        // createRoom optimistic add, just replace in-place.
                        const idx = prev.findIndex((r) => r.slug === room.slug);
                        if (idx === -1)
                            return [...prev, room];
                        const next = [...prev];
                        next[idx] = room;
                        return next;
                    });
                    break;
                }
                case 'room.updated': {
                    if (!evt.room)
                        return;
                    const room = evt.room;
                    setRooms((prev) => {
                        const idx = prev.findIndex((r) => r.slug === room.slug);
                        if (idx === -1)
                            return prev;
                        const next = [...prev];
                        next[idx] = room;
                        return next;
                    });
                    break;
                }
                case 'room.archived': {
                    const slug = evt.slug ?? evt.room?.slug;
                    if (!slug)
                        return;
                    setRooms((prev) => prev.filter((r) => r.slug !== slug));
                    break;
                }
                default:
                    break;
            }
        });
        return unsubscribe;
    }, [opts.ws]);
    // ---- Actions --------------------------------------------------------------
    const createRoom = (0, react_1.useCallback)(async (input) => {
        const room = await (0, api_1.createRoom)(buildApiOptions(), input);
        if (mountedRef.current) {
            setRooms((prev) => {
                // Idempotent w.r.t. WS echo: dedup by slug.
                if (prev.some((r) => r.slug === room.slug))
                    return prev;
                return [...prev, room];
            });
        }
        return room;
    }, [buildApiOptions]);
    const archiveRoom = (0, react_1.useCallback)(async (slug) => {
        await (0, api_1.archiveRoom)(buildApiOptions(), slug);
        if (mountedRef.current) {
            setRooms((prev) => prev.filter((r) => r.slug !== slug));
        }
    }, [buildApiOptions]);
    const joinRoom = (0, react_1.useCallback)(async (slug) => {
        return (0, api_1.joinRoom)(buildApiOptions(), slug);
    }, [buildApiOptions]);
    return (0, react_1.useMemo)(() => ({ rooms, isLoading, error, refetch, createRoom, archiveRoom, joinRoom }), [rooms, isLoading, error, refetch, createRoom, archiveRoom, joinRoom]);
}
//# sourceMappingURL=useHangoutRooms.js.map