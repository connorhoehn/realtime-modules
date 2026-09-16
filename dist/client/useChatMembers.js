"use strict";
// realtime-modules/src/client/useChatMembers.ts
//
// useChatMembers(channel) — who is in a chat channel, and the two ways it
// changes: adding people (with the history they may read) and removing
// them. The roster comes from the gateway ChatService:
//
//   out: { service:'chat', action:'members', channel }
//   out: { service:'chat', action:'addMembers', channel, userIds, history:{mode,days?}, names? }
//   out: { service:'chat', action:'removeMember', channel, userId, name? }
//   in:  { type:'chat', action:'members'|'membersUpdated', channel, open, members }
//        { type:'chat', action:'removed', channel, byUserId, timestamp } — this connection was removed
//
// `open` is true for a channel with no membership rows — everyone the
// gateway admits is in it, and `members` is empty. The first add closes it.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useChatMembers = useChatMembers;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
function useChatMembers(channel) {
    const { send, onMessage } = (0, GatewaySocketProvider_1.useGateway)();
    const [members, setMembers] = (0, react_1.useState)([]);
    const [open, setOpen] = (0, react_1.useState)(true);
    const [loading, setLoading] = (0, react_1.useState)(true);
    const [removed, setRemoved] = (0, react_1.useState)(null);
    const channelRef = (0, react_1.useRef)(channel);
    (0, react_1.useEffect)(() => { channelRef.current = channel; }, [channel]);
    const refresh = (0, react_1.useCallback)(() => {
        if (!channelRef.current)
            return;
        send({ service: 'chat', action: 'members', channel: channelRef.current });
    }, [send]);
    (0, react_1.useEffect)(() => {
        const unsubscribe = onMessage((msg) => {
            if (msg.type !== 'chat' || msg.channel !== channelRef.current)
                return;
            const raw = msg;
            if (msg.action === 'removed') {
                setRemoved({ byUserId: typeof raw.byUserId === 'string' ? raw.byUserId : '', at: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString() });
                setMembers([]);
                setOpen(false);
                setLoading(false);
                return;
            }
            if (msg.action !== 'members' && msg.action !== 'membersUpdated')
                return;
            const list = Array.isArray(raw.members) ? raw.members : [];
            setMembers(list.map(asMember).filter(Boolean));
            setOpen(raw.open === true);
            setLoading(false);
        });
        return unsubscribe;
    }, [onMessage]);
    (0, react_1.useEffect)(() => {
        setMembers([]);
        setOpen(true);
        setLoading(true);
        setRemoved(null);
        refresh();
    }, [channel, refresh]);
    const addMembers = (0, react_1.useCallback)((userIds, history, names) => {
        send({
            service: 'chat',
            action: 'addMembers',
            channel: channelRef.current,
            userIds,
            history,
            ...(names ? { names } : {}),
        });
    }, [send]);
    const removeMember = (0, react_1.useCallback)((userId, name) => {
        send({
            service: 'chat',
            action: 'removeMember',
            channel: channelRef.current,
            userId,
            ...(name ? { name } : {}),
        });
    }, [send]);
    const isMember = (0, react_1.useCallback)((userId) => open || members.some((m) => m.userId === userId), [open, members]);
    return { members, open, loading, addMembers, removeMember, refresh, isMember, removed };
}
function asMember(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r.userId !== 'string' || !r.userId)
        return null;
    return {
        userId: r.userId,
        role: r.role === 'owner' ? 'owner' : 'member',
        addedBy: typeof r.addedBy === 'string' ? r.addedBy : '',
        addedAt: typeof r.addedAt === 'string' ? r.addedAt : '',
        historyFrom: typeof r.historyFrom === 'string' ? r.historyFrom : null,
    };
}
exports.default = useChatMembers;
//# sourceMappingURL=useChatMembers.js.map