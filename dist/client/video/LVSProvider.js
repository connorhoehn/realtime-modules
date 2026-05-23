"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LVSProvider = LVSProvider;
exports.useLVSContext = useLVSContext;
exports.useSafeLVSContext = useSafeLVSContext;
exports.resolveLVSConfig = resolveLVSConfig;
const jsx_runtime_1 = require("react/jsx-runtime");
// LVSProvider — React context for LVS (live-video-streaming) configuration.
// Hooks downstream (useLVSPublisher / useLVSSubscriber / useLVSHangout)
// read baseUrl + auth-token from here. Mirrors GatewaySocketProvider's
// shape so consumers see a familiar context surface.
const react_1 = require("react");
const LVSContext = (0, react_1.createContext)(null);
function defaultLog(msg, level = 'info') {
    const tag = '[lvs]';
    if (level === 'err')
        console.error(tag, msg);
    else if (level === 'warn')
        console.warn(tag, msg);
    else
        console.log(tag, msg);
}
function LVSProvider({ baseUrl, getAuthToken, log, children }) {
    const value = (0, react_1.useMemo)(() => ({
        baseUrl: baseUrl ?? '',
        getAuthToken,
        log: log ?? defaultLog,
    }), [baseUrl, getAuthToken, log]);
    return (0, jsx_runtime_1.jsx)(LVSContext.Provider, { value: value, children: children });
}
/**
 * Read the LVSProvider's config. Throws an actionable error if the
 * caller is outside a provider. Hooks may also accept per-call overrides
 * (baseUrl + getAuthToken) and fall back to this context when omitted.
 */
function useLVSContext() {
    const ctx = (0, react_1.useContext)(LVSContext);
    if (!ctx) {
        throw new Error('[lvs] useLVSContext called outside <LVSProvider>. Wrap your app in <LVSProvider baseUrl="..." getAuthToken={...}> or pass baseUrl + getAuthToken directly to the hook.');
    }
    return ctx;
}
/**
 * Non-throwing variant of {@link useLVSContext}: returns null when the
 * caller is outside a provider. Hooks that accept full opts overrides
 * (baseUrl + getAuthToken) should use this so the provider becomes
 * truly optional — avoids the try/catch-around-useContext pattern that
 * each hook used to duplicate (audit P0).
 */
function useSafeLVSContext() {
    return (0, react_1.useContext)(LVSContext);
}
/**
 * Internal helper for hooks: resolve the effective config by overlaying
 * per-call options on top of the provider context. Returns null if the
 * caller didn't pass overrides AND there's no provider — letting hooks
 * gracefully fall back to opt-in behavior.
 */
function resolveLVSConfig(opts) {
    // Note: this is called inside hooks. We can't conditionally call
    // useContext, but consumers can pass `null` for ctx via try/catch.
    // The caller (a hook) will wrap useLVSContext in try/catch + use this.
    if (opts.baseUrl !== undefined && opts.getAuthToken) {
        return {
            baseUrl: opts.baseUrl,
            getAuthToken: opts.getAuthToken,
            log: opts.log ?? defaultLog,
        };
    }
    return null;
}
//# sourceMappingURL=LVSProvider.js.map