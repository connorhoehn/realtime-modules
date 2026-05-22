"use strict";
// realtime-modules/src/client/useNotifications.ts
//
// useNotifications() — React hook that surfaces app-level notifications as a
// unified inbox. Unlike the channel-scoped hooks (useChat, usePresence, etc.),
// notifications are USER-scoped: they arrive regardless of which channel the
// user currently has open, so a single hook covers the whole app.
//
// ──────────────────────────────────────────────────────────────────────────────
// Inbound frame shapes (gateway notification service):
//
//   { type: 'notification:new',
//     service: 'notification',
//     payload: { id, type, title, body?, timestamp, channel?, payload?, action? } }
//
//   { type: 'notification:read',
//     service: 'notification',
//     payload: { id } }
//
//   { type: 'notification:bulk-update',
//     service: 'notification',
//     payload: { notifications: Notification[] } }
//
// Gateway won't emit these until M3+. The hook is the consumer surface; the
// server-side wiring is deferred.
//
// ──────────────────────────────────────────────────────────────────────────────
// Design notes:
//   - Listens on `notification:*` frames via useGateway().onMessage (no channel
//     filter — notifications are user-scoped).
//   - Read-state is persisted in localStorage under STORAGE_KEY so a page
//     refresh does not lose read marks (only the id→read map is stored, not
//     full payloads, so stale data is never surfaced on reload).
//   - The in-memory list is capped at MAX_NOTIFICATIONS (default 100). When the
//     cap is reached the oldest notification is dropped automatically.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useNotifications = useNotifications;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_MAX = 100;
const DEFAULT_STORAGE_KEY = 'rmn:notifications:read';
// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
/**
 * useNotifications — subscribe to app-level gateway notification frames.
 *
 * Must be called inside a {@link GatewaySocketProvider}.
 *
 * ```tsx
 * const { notifications, unreadCount, markAsRead } = useNotifications();
 * ```
 */
function useNotifications(options = {}) {
    const { maxNotifications = DEFAULT_MAX, storageKey = DEFAULT_STORAGE_KEY } = options;
    const { onMessage } = (0, GatewaySocketProvider_1.useGateway)();
    // ------------------------------------------------------------------
    // Restore persisted read-state from localStorage on first mount.
    // We store a plain object { [id]: true } so refresh doesn't lose marks.
    // ------------------------------------------------------------------
    const [notifications, setNotifications] = (0, react_1.useState)(() => []);
    // Keep a stable ref to the current read-map so we can persist without
    // re-registering the onMessage handler.
    const readMapRef = (0, react_1.useRef)(loadReadMap(storageKey));
    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    /** Persist the current read-map to localStorage (best-effort). */
    const persistReadMap = (0, react_1.useCallback)((map) => {
        try {
            localStorage.setItem(storageKey, JSON.stringify(map));
        }
        catch {
            // localStorage unavailable (SSR / private mode) — silently ignore.
        }
    }, [storageKey]);
    /** Merge an incoming Notification with persisted read-state. */
    const applyReadState = (0, react_1.useCallback)((n) => {
        return readMapRef.current[n.id] ? { ...n, read: true } : n;
    }, []);
    // ------------------------------------------------------------------
    // Inbound frame handler — registered once, no channel filter.
    // ------------------------------------------------------------------
    (0, react_1.useEffect)(() => {
        const unsubscribe = onMessage((msg) => {
            if (msg.type === 'notification:new') {
                const raw = msg.payload;
                const n = asNotification(raw);
                if (!n)
                    return;
                setNotifications((prev) => {
                    const withRead = applyReadState(n);
                    const next = [...prev, withRead];
                    // Trim to cap — drop the oldest (head of the list).
                    if (next.length > maxNotifications) {
                        return next.slice(next.length - maxNotifications);
                    }
                    return next;
                });
            }
            else if (msg.type === 'notification:read') {
                const raw = msg;
                const payload = raw.payload;
                const id = typeof payload?.id === 'string' ? payload.id : null;
                if (!id)
                    return;
                readMapRef.current = { ...readMapRef.current, [id]: true };
                persistReadMap(readMapRef.current);
                setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
            }
            else if (msg.type === 'notification:bulk-update') {
                const raw = msg;
                const payload = raw.payload;
                const list = Array.isArray(payload?.notifications) ? payload.notifications : [];
                const parsed = list
                    .map(asNotification)
                    .filter(Boolean);
                if (parsed.length === 0)
                    return;
                setNotifications((prev) => {
                    const existingIds = new Set(prev.map((n) => n.id));
                    const incoming = parsed.map(applyReadState);
                    const merged = [
                        ...prev.map((existing) => {
                            // Update in-place if the server sent a new version.
                            const updated = incoming.find((i) => i.id === existing.id);
                            return updated ?? existing;
                        }),
                        ...incoming.filter((i) => !existingIds.has(i.id)),
                    ];
                    // Sort oldest-first by timestamp.
                    merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
                    if (merged.length > maxNotifications) {
                        return merged.slice(merged.length - maxNotifications);
                    }
                    return merged;
                });
            }
        });
        return unsubscribe;
    }, [onMessage, applyReadState, maxNotifications, persistReadMap]);
    // ------------------------------------------------------------------
    // Public actions
    // ------------------------------------------------------------------
    const markAsRead = (0, react_1.useCallback)((id) => {
        readMapRef.current = { ...readMapRef.current, [id]: true };
        persistReadMap(readMapRef.current);
        setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    }, [persistReadMap]);
    const markAllRead = (0, react_1.useCallback)(() => {
        setNotifications((prev) => {
            const next = prev.map((n) => ({ ...n, read: true }));
            const map = {};
            for (const n of next)
                map[n.id] = true;
            readMapRef.current = map;
            persistReadMap(map);
            return next;
        });
    }, [persistReadMap]);
    const remove = (0, react_1.useCallback)((id) => {
        setNotifications((prev) => prev.filter((n) => n.id !== id));
    }, []);
    const clearAll = (0, react_1.useCallback)(() => {
        readMapRef.current = {};
        persistReadMap({});
        setNotifications([]);
    }, [persistReadMap]);
    // ------------------------------------------------------------------
    // Derived state
    // ------------------------------------------------------------------
    const unreadCount = notifications.filter((n) => !n.read).length;
    return { notifications, unreadCount, markAsRead, markAllRead, remove, clearAll };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Load read-map from localStorage. Returns {} on any failure. */
function loadReadMap(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw)
            return {};
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        // parse error or no localStorage
    }
    return {};
}
/** Coerce an arbitrary payload object to a Notification, or return null. */
function asNotification(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const m = raw;
    if (typeof m.id !== 'string' || !m.id)
        return null;
    if (typeof m.type !== 'string')
        return null;
    if (typeof m.title !== 'string')
        return null;
    if (typeof m.timestamp !== 'string')
        return null;
    const n = {
        id: m.id,
        type: m.type,
        title: m.title,
        timestamp: m.timestamp,
    };
    if (typeof m.body === 'string')
        n.body = m.body;
    if (typeof m.read === 'boolean')
        n.read = m.read;
    if (typeof m.channel === 'string')
        n.channel = m.channel;
    if (typeof m.payload === 'object' && m.payload !== null) {
        n.payload = m.payload;
    }
    if (typeof m.action === 'object' && m.action !== null) {
        const a = m.action;
        if (typeof a.label === 'string') {
            n.action = {
                label: a.label,
                ...(typeof a.href === 'string' ? { href: a.href } : {}),
                ...(typeof a.onClickEvent === 'string' ? { onClickEvent: a.onClickEvent } : {}),
            };
        }
    }
    return n;
}
//# sourceMappingURL=useNotifications.js.map