"use strict";
// realtime-modules/src/client/usePins.ts
//
// usePins(channel) — the messages pinned to the top of a channel.
//
// ## Why a pin is not message metadata
//
// A pin is CHANNEL state: set by one person, seen by everyone, outliving the
// session that set it. Message metadata is written once by the sender and
// replayed verbatim, so a later pin by somebody else has nowhere to live
// there, and unpinning would mean rewriting another user's message. The
// gateway keeps pins in their own store and serves them over
// `/api/chat/pins`; this hook is the client half.
//
// ## Why writes are optimistic and then reconciled
//
// Pinning is a deliberate act, so the pinned marker has to appear under the
// click. But the server's list is what everyone else sees, and it carries the
// real `pinnedBy` — so the optimistic row is replaced by a refresh rather than
// trusted. A failed write leaves the panel the way it was.
Object.defineProperty(exports, "__esModule", { value: true });
exports.usePins = usePins;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
function usePins(channel) {
    const gateway = (0, GatewaySocketProvider_1.useGateway)();
    const rest = gateway.rest;
    // The specific functions, not the context: the gateway value is rebuilt on
    // every connection-state change, and re-reading a pin list on reconnect is
    // work nobody asked for.
    const listPins = rest?.listPins;
    const pinFn = rest?.pin;
    const unpinFn = rest?.unpin;
    const [pins, setPins] = (0, react_1.useState)([]);
    const [isLoading, setIsLoading] = (0, react_1.useState)(false);
    const [readError, setReadError] = (0, react_1.useState)(undefined);
    const [writeError, setWriteError] = (0, react_1.useState)(undefined);
    const [tick, setTick] = (0, react_1.useState)(0);
    const refresh = (0, react_1.useCallback)(() => setTick((n) => n + 1), []);
    // Channel change is its own effect. Folding it into the read below meant
    // the reconciling read that FOLLOWS a failed write also cleared the write's
    // error — so the pin rolled back and the panel said nothing about why.
    (0, react_1.useEffect)(() => {
        // The previous channel's marker sitting on this channel's messages is
        // worse than no marker at all.
        setPins([]);
        setReadError(undefined);
        setWriteError(undefined);
    }, [channel]);
    (0, react_1.useEffect)(() => {
        if (!channel || !listPins) {
            setIsLoading(false);
            return;
        }
        let cancelled = false;
        setIsLoading(true);
        void (async () => {
            try {
                const next = await listPins(channel);
                if (cancelled)
                    return;
                setPins(next);
                // Cleared on SUCCESS, never on start: a read that has not answered yet
                // is not evidence the last failure is over.
                setReadError(undefined);
            }
            catch (err) {
                if (!cancelled)
                    setReadError(err instanceof Error ? err : new Error(String(err)));
            }
            finally {
                if (!cancelled)
                    setIsLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [channel, listPins, tick]);
    const channelRef = (0, react_1.useRef)(channel);
    (0, react_1.useEffect)(() => { channelRef.current = channel; }, [channel]);
    const pin = (0, react_1.useCallback)(async (input) => {
        const ch = channelRef.current;
        if (!ch || !pinFn)
            return;
        // Optimistic: the marker appears under the click. `pinnedBy` is a
        // placeholder — the refresh below replaces it with the real one rather
        // than inventing an identity here.
        setPins((prev) => [
            {
                channelId: ch,
                messageId: input.messageId,
                pinnedBy: '',
                pinnedAt: new Date().toISOString(),
                preview: input.text,
                author: input.author,
            },
            ...prev.filter((p) => p.messageId !== input.messageId),
        ]);
        try {
            await pinFn({ channel: ch, ...input });
            setWriteError(undefined);
        }
        catch (err) {
            setWriteError(err instanceof Error ? err : new Error(String(err)));
        }
        finally {
            // Either way: the server's list is the one everyone else sees, so a
            // failed write is rolled back by the same read that confirms a good one.
            refresh();
        }
    }, [pinFn, refresh]);
    const unpin = (0, react_1.useCallback)(async (messageId) => {
        const ch = channelRef.current;
        if (!ch || !unpinFn)
            return;
        setPins((prev) => prev.filter((p) => p.messageId !== messageId));
        try {
            await unpinFn(ch, messageId);
            setWriteError(undefined);
        }
        catch (err) {
            setWriteError(err instanceof Error ? err : new Error(String(err)));
        }
        finally {
            refresh();
        }
    }, [unpinFn, refresh]);
    const pinnedIds = (0, react_1.useMemo)(() => new Set(pins.map((p) => p.messageId)), [pins]);
    return { pins, pinnedIds, pin, unpin, refresh, isLoading, error: writeError ?? readError };
}
exports.default = usePins;
//# sourceMappingURL=usePins.js.map