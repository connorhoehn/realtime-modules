"use strict";
// useLVSHangoutShared — context-shared variant of useLVSHangout.
//
// Multiple consumers of the SAME (channelArn, participantId) all receive
// the same UseLVSHangoutResult — one WS subscription, one set of WHEP
// PCs, one camera stream — rather than each opening its own discovery
// connection. Closes the duplicate-subscription cost confirmed in the
// 2026-06-04 gateway demo (memory: uselvshangout_shared_followup).
//
// Usage:
//
//   <LVSHangoutSessionProvider opts={{ stageToken, participantId, ... }}>
//     <ComponentA />  {/* uses useLVSHangoutShared() */}
//     <ComponentB />  {/* uses useLVSHangoutShared() */}
//   </LVSHangoutSessionProvider>
//
// All consumers receive the same value. The provider mounts the
// underlying useLVSHangout ONCE at its boundary; React's normal
// memoization carries the result to children. To re-key the session
// (different participant or different token), pass a `key` prop on
// the provider derived from the identity tuple so React re-mounts it
// cleanly.
//
// Migration: any consumer that currently calls useLVSHangout(opts) can
// be moved under a single shared provider and swap to
// useLVSHangoutShared() with no API change — the returned shape is
// identical (it IS the same value).
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LVSHangoutSessionContext = void 0;
exports.LVSHangoutSessionProvider = LVSHangoutSessionProvider;
exports.useLVSHangoutShared = useLVSHangoutShared;
const React = __importStar(require("react"));
const useLVSHangout_1 = require("./useLVSHangout");
/**
 * React context carrying the shared useLVSHangout session. Most callers
 * should not read this directly — use {@link useLVSHangoutShared}
 * instead. Exposed mostly for advanced consumers (custom providers,
 * tests).
 */
exports.LVSHangoutSessionContext = React.createContext(null);
/**
 * Provider that mounts useLVSHangout ONCE at its boundary so multiple
 * downstream consumers share the same session — one WS subscription,
 * one set of WHEP PCs, one camera stream.
 */
function LVSHangoutSessionProvider({ opts, children }) {
    const session = (0, useLVSHangout_1.useLVSHangout)(opts);
    return React.createElement(exports.LVSHangoutSessionContext.Provider, { value: session }, children);
}
/**
 * Read the shared useLVSHangout session from context. Throws when
 * called outside {@link LVSHangoutSessionProvider}.
 *
 * The returned value is the SAME object as the underlying
 * useLVSHangout(opts) at the provider boundary — every getter,
 * callback, and ref is identical across all consumers. No additional
 * WS subscription is opened per consumer.
 */
function useLVSHangoutShared() {
    const session = React.useContext(exports.LVSHangoutSessionContext);
    if (!session) {
        throw new Error('useLVSHangoutShared() must be called inside <LVSHangoutSessionProvider>. If a single consumer needs its own session, use useLVSHangout() directly.');
    }
    return session;
}
//# sourceMappingURL=useLVSHangoutShared.js.map