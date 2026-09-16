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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useGateway } from './GatewaySocketProvider';
import type { GatewayMessage } from './types';
import type { ClientFramePayload } from '@connorhoehn/event-catalog/client-frames';

export type ChatMemberRole = 'owner' | 'member';

export interface ChatMemberEntry {
  userId: string;
  role: ChatMemberRole;
  addedBy: string;
  addedAt: string;
  historyFrom: string | null;
}

export interface ChatHistoryChoice {
  mode: 'none' | 'days' | 'all';
  days?: number;
}

export interface UseChatMembersReturn {
  members: ChatMemberEntry[];
  /** No membership rows: everyone the gateway admits is in it. */
  open: boolean;
  /** True until the first roster arrives for this channel. */
  loading: boolean;
  /** Add people; `names` lets the thread's system line name them. */
  addMembers: (userIds: string[], history: ChatHistoryChoice, names?: Record<string, string>) => void;
  removeMember: (userId: string, name?: string) => void;
  refresh: () => void;
  /** True when `userId` may read the channel: it is open, or they are an active member. */
  isMember: (userId: string) => boolean;
  /** Set when the gateway removed THIS connection from the channel (`{type:'chat', action:'removed'}`): who did it, and when. Cleared on a channel change. */
  removed: { byUserId: string; at: string } | null;
}

export function useChatMembers(channel: string): UseChatMembersReturn {
  const { send, onMessage } = useGateway();
  const [members, setMembers] = useState<ChatMemberEntry[]>([]);
  const [open, setOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [removed, setRemoved] = useState<{ byUserId: string; at: string } | null>(null);
  const channelRef = useRef(channel);
  useEffect(() => { channelRef.current = channel; }, [channel]);

  const refresh = useCallback(() => {
    if (!channelRef.current) return;
    send({ service: 'chat', action: 'members', channel: channelRef.current } satisfies ClientFramePayload<'client.chat.members'>);
  }, [send]);

  useEffect(() => {
    const unsubscribe = onMessage((msg: GatewayMessage) => {
      if (msg.type !== 'chat' || msg.channel !== channelRef.current) return;
      const raw = msg as Record<string, unknown>;
      if (msg.action === 'removed') {
        setRemoved({ byUserId: typeof raw.byUserId === 'string' ? raw.byUserId : '', at: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString() });
        setMembers([]);
        setOpen(false);
        setLoading(false);
        return;
      }
      if (msg.action !== 'members' && msg.action !== 'membersUpdated') return;
      const list = Array.isArray(raw.members) ? (raw.members as unknown[]) : [];
      setMembers(list.map(asMember).filter(Boolean) as ChatMemberEntry[]);
      setOpen(raw.open === true);
      setLoading(false);
    });
    return unsubscribe;
  }, [onMessage]);

  useEffect(() => {
    setMembers([]);
    setOpen(true);
    setLoading(true);
    setRemoved(null);
    refresh();
  }, [channel, refresh]);

  const addMembers = useCallback(
    (userIds: string[], history: ChatHistoryChoice, names?: Record<string, string>) => {
      send({
        service: 'chat',
        action: 'addMembers',
        channel: channelRef.current,
        userIds,
        history,
        ...(names ? { names } : {}),
      } satisfies ClientFramePayload<'client.chat.addMembers'>);
    },
    [send],
  );

  const removeMember = useCallback(
    (userId: string, name?: string) => {
      send({
        service: 'chat',
        action: 'removeMember',
        channel: channelRef.current,
        userId,
        ...(name ? { name } : {}),
      } satisfies ClientFramePayload<'client.chat.removeMember'>);
    },
    [send],
  );

  const isMember = useCallback(
    (userId: string) => open || members.some((m) => m.userId === userId),
    [open, members],
  );

  return { members, open, loading, addMembers, removeMember, refresh, isMember, removed };
}

function asMember(raw: unknown): ChatMemberEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.userId !== 'string' || !r.userId) return null;
  return {
    userId: r.userId,
    role: r.role === 'owner' ? 'owner' : 'member',
    addedBy: typeof r.addedBy === 'string' ? r.addedBy : '',
    addedAt: typeof r.addedAt === 'string' ? r.addedAt : '',
    historyFrom: typeof r.historyFrom === 'string' ? r.historyFrom : null,
  };
}

export default useChatMembers;
