"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseChatPluginMessage = parseChatPluginMessage;
// 0.119 (lane R4): the one reading of a router plugin's chat input.
const channelAccess_1 = require("../server-ws/channelAccess");
/**
 * Reads a chat `message` frame from a plugin hook. Returns null unless the
 * frame is a chat message AND its server-stamped sender (`message.userId`,
 * else `metadata.userId`) equals the authenticated publisher. A frame with no
 * stamp passes; a missing publisher (server-originated publish) fails, since
 * there is no one to attribute the message to.
 */
function parseChatPluginMessage(input, opts = {}) {
    const frame = input.message;
    if (!frame || frame.type !== 'chat' || frame.action !== 'message' || !frame.message)
        return null;
    const sender = input.userId ?? opts.resolveUserId?.(input.clientId);
    const stamped = frame.message.userId ?? frame.message.metadata?.userId;
    if (!sender || (typeof stamped === 'string' && stamped !== sender))
        return null;
    const name = frame.message.metadata?.displayName;
    return {
        channel: (0, channelAccess_1.baseChannel)(input.channelId),
        sender,
        message: frame.message,
        text: typeof frame.message.message === 'string' ? frame.message.message : '',
        displayName: typeof name === 'string' && name ? name : undefined,
    };
}
//# sourceMappingURL=pluginMessage.js.map