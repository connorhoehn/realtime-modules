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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGateway } from './GatewaySocketProvider';
import type { GatewayRest, PinnedMessage } from './GatewaySocketProvider';

export interface UsePinsResult {
  pins: PinnedMessage[];
  /** Ids only — what a message list needs to mark a message as pinned. */
  pinnedIds: Set<string>;
  pin: (input: { messageId: string; text: string; author: string }) => Promise<void>;
  unpin: (messageId: string) => Promise<void>;
  refresh: () => void;
  /** True until the first read for the current channel settles. */
  isLoading: boolean;
  /**
   * The last failure, if any.
   *
   * A failed WRITE outranks a successful read, and stays until the next write
   * succeeds or the channel changes. Every write is followed by a reconciling
   * read, so an error the read could clear would be gone before anyone saw it
   * — the pin would roll back off the screen with no explanation, which is the
   * one thing worse than the write failing.
   */
  error?: Error;
}

export function usePins(channel: string | null | undefined): UsePinsResult {
  const gateway = useGateway();
  const rest = (gateway as unknown as { rest?: GatewayRest | null }).rest;

  // The specific functions, not the context: the gateway value is rebuilt on
  // every connection-state change, and re-reading a pin list on reconnect is
  // work nobody asked for.
  const listPins = rest?.listPins;
  const pinFn = rest?.pin;
  const unpinFn = rest?.unpin;

  const [pins, setPins] = useState<PinnedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [readError, setReadError] = useState<Error | undefined>(undefined);
  const [writeError, setWriteError] = useState<Error | undefined>(undefined);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // Channel change is its own effect. Folding it into the read below meant
  // the reconciling read that FOLLOWS a failed write also cleared the write's
  // error — so the pin rolled back and the panel said nothing about why.
  useEffect(() => {
    // The previous channel's marker sitting on this channel's messages is
    // worse than no marker at all.
    setPins([]);
    setReadError(undefined);
    setWriteError(undefined);
  }, [channel]);

  useEffect(() => {
    if (!channel || !listPins) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      try {
        const next = await listPins(channel);
        if (cancelled) return;
        setPins(next);
        // Cleared on SUCCESS, never on start: a read that has not answered yet
        // is not evidence the last failure is over.
        setReadError(undefined);
      } catch (err) {
        if (!cancelled) setReadError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [channel, listPins, tick]);

  const channelRef = useRef(channel);
  useEffect(() => { channelRef.current = channel; }, [channel]);

  const pin = useCallback(
    async (input: { messageId: string; text: string; author: string }) => {
      const ch = channelRef.current;
      if (!ch || !pinFn) return;
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
      } catch (err) {
        setWriteError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        // Either way: the server's list is the one everyone else sees, so a
        // failed write is rolled back by the same read that confirms a good one.
        refresh();
      }
    },
    [pinFn, refresh],
  );

  const unpin = useCallback(
    async (messageId: string) => {
      const ch = channelRef.current;
      if (!ch || !unpinFn) return;
      setPins((prev) => prev.filter((p) => p.messageId !== messageId));
      try {
        await unpinFn(ch, messageId);
        setWriteError(undefined);
      } catch (err) {
        setWriteError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        refresh();
      }
    },
    [unpinFn, refresh],
  );

  const pinnedIds = useMemo(() => new Set(pins.map((p) => p.messageId)), [pins]);

  return { pins, pinnedIds, pin, unpin, refresh, isLoading, error: writeError ?? readError };
}

export default usePins;
