"use strict";
// realtime-modules/src/client/useChannel.ts
//
// useChannel(channel, opts?) — composite hook bundling all per-channel features.
//
// Returns a single object with chat, presence, reactions, and activity — each
// is the full hook result or null when the feature is disabled via opts.features.
//
// Default: all four features are enabled.
//
// Example:
//   const { chat, presence, reactions, activity } = useChannel('chat:my-room');
//   chat?.sendMessage('hi');
//   presence?.setStatus('away');
//
// Selective enable:
//   const { chat, presence } = useChannel('chat:my-room', {
//     features: { chat: true, presence: true, reactions: false, activity: false },
//   });
//
// NOTE: All four sub-hooks are called unconditionally to satisfy React's Rules
// of Hooks. When a feature flag is false, the hook still runs internally but
// its result is mapped to null in the returned object.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useChannel = useChannel;
const useChat_1 = require("./useChat");
const usePresence_1 = require("./usePresence");
const useReactions_1 = require("./useReactions");
const useActivity_1 = require("./useActivity");
/**
 * Composite hook that bundles useChat + usePresence + useReactions + useActivity
 * for a single channel. Reduces boilerplate for apps that want "all the channel
 * features" without wiring four separate hooks.
 *
 * Each sub-hook is opt-out via opts.features (all default to enabled).
 * Returns null for disabled features so consumers can safely optional-chain:
 *   chat?.sendMessage('hi')
 */
function useChannel(channel, opts) {
    const features = {
        chat: opts?.features?.chat ?? true,
        presence: opts?.features?.presence ?? true,
        reactions: opts?.features?.reactions ?? true,
        activity: opts?.features?.activity ?? true,
    };
    const reactionsOpts = opts?.reactionsTargetId
        ? { targetId: opts.reactionsTargetId }
        : undefined;
    // All four hooks are called unconditionally — React's Rules of Hooks require
    // hook call order to be stable across renders. Feature flags only gate whether
    // the result is exposed to the consumer.
    const chat = (0, useChat_1.useChat)(channel);
    const presence = (0, usePresence_1.usePresence)(channel);
    const reactions = (0, useReactions_1.useReactions)(channel, reactionsOpts);
    const activity = (0, useActivity_1.useActivity)(channel);
    return {
        channel,
        chat: features.chat ? chat : null,
        presence: features.presence ? presence : null,
        reactions: features.reactions ? reactions : null,
        activity: features.activity ? activity : null,
    };
}
//# sourceMappingURL=useChannel.js.map