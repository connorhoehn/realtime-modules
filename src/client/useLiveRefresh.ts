// realtime-modules/src/client/useLiveRefresh.ts
//
// React binding for createLiveRefresh (0.145.0): read a record, re-read it on
// a frame hint, and poll when frames cannot be trusted to arrive.
//
//   const { data: project, live } = useLiveRefresh(readProject, {
//     channel: `studio:project:${id}`,
//     isHint: (f) => f.type === 'studio.work.changed' && f.projectId === id,
//     coalesceMs: 100,
//     pollMs: 15_000,
//   });
//
// `live` = the socket is connected AND the channel's subscribe was
// acknowledged in this session. A refused channel (`{ type: 'error', channel }`)
// or one the server never answers (the subscribe service's silence is a
// refusal) stays on polling. Becoming live — including after every reconnect,
// since a new session puts the channel back to pending until its ack — reads
// the record once to catch up. Polling pauses while the document is hidden.
//
// The socket: the `socket` option, else the nearest SharedSocketProvider.
// GatewaySocketProvider is not read directly — bridge it with
// `<SharedSocketProvider fromGateway>`. With no socket at all the hook polls.
// The channel is held through the shared transport, refcounted with every
// other holder (two views of one project send one subscribe, and the first to
// unmount does not cut the other).

import { useEffect, useRef, useState } from 'react';
import { createLiveRefresh } from './liveRefresh';
import type { LiveRefresh, LiveRefreshOptions } from './liveRefresh';
import { useSharedSocket } from './SharedSocketProvider';
import type { SharedChannelState, SharedSocketChannelService, SharedSocketTransport } from './sharedSocketTransport';
import type { ConnectionState } from './types';
import { useDocumentHidden } from './useDocumentHidden';

/** A socket for useLiveRefresh: `useSharedSocket()`'s value satisfies it. */
export interface LiveRefreshSocket {
  transport: SharedSocketTransport;
  /** Omitted: treated as connected. */
  connectionState?: ConnectionState;
  /**
   * The socket's session epoch. When given, an ack counts only in the session
   * it was seen in, so the render that reports a reconnect is not live on the
   * previous session's ack.
   */
  sessionEpoch?: number;
}

export interface UseLiveRefreshOptions<T>
  extends Pick<LiveRefreshOptions<T>, 'coalesceMs' | 'livePollMs' | 'pollMs' | 'maxBackoff' | 'onData' | 'onError'> {
  /** A channel to hold while mounted; live waits for its ack. Omitted: live = connected (frames the socket gets anyway). */
  channel?: string | null;
  /** The channel's subscribe service. Default: `pipeline` for `pipeline:*`, else `subscribe`. */
  service?: SharedSocketChannelService;
  /**
   * Which inbound frames re-read the record. Default with a `channel`: frames
   * whose `channel` is it (acks and errors excepted); without one, none.
   */
  isHint?: (frame: Record<string, unknown>) => boolean;
  /** Extra frames that refuse the channel (e.g. an error naming the router channel a wire channel maps to). */
  isRefusal?: (frame: Record<string, unknown>) => boolean;
  /** Overrides the provider. `null`: no socket, poll only. */
  socket?: LiveRefreshSocket | null;
  /** False: no reads, no hold. Default true. */
  enabled?: boolean;
  /** A change starts over (data cleared, read at once), as a `channel` change does. */
  key?: unknown;
}

export interface UseLiveRefreshResult<T> {
  /** The last successful read; undefined before the first (and after a channel / key change). */
  data: T | undefined;
  /** The last read's error; cleared by a success. */
  error: unknown;
  /** No data and no error yet. */
  loading: boolean;
  /** Connected and the channel acknowledged: hints drive reads, polling is the slow safety read. */
  live: boolean;
  /** The socket's state, or null without a socket. */
  connectionState: ConnectionState | null;
  /** The channel's state with the server (`'unheld'` without a channel). */
  channelState: SharedChannelState;
  /** Read now. */
  refresh: () => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isControlFrame = (f: Record<string, unknown>) =>
  f.type === 'error' || f.action === 'subscribed' || f.action === 'unsubscribed';

/** Read a record, re-read it on frame hints while live, poll otherwise. See the file header. */
export function useLiveRefresh<T>(
  read: (signal: AbortSignal) => Promise<T>,
  options: UseLiveRefreshOptions<T> = {},
): UseLiveRefreshResult<T> {
  const provided = useSharedSocket();
  const socket = options.socket !== undefined ? options.socket : provided;
  const transport = socket?.transport;
  const connectionState: ConnectionState | null = socket ? socket.connectionState ?? 'connected' : null;
  const enabled = options.enabled !== false;
  const channel = enabled && options.channel ? options.channel : undefined;
  const { service, coalesceMs, livePollMs, pollMs, maxBackoff } = options;

  // Callbacks travel by ref: a fresh closure per render re-creates nothing.
  const latest = useRef({ read, options });
  latest.current = { read, options };

  // The channel, held while mounted (refcounted on the shared transport).
  useEffect(() => {
    if (!transport || !channel) return undefined;
    return transport.subscribe(channel, service ? { service } : undefined);
  }, [transport, channel, service]);

  // The channel's state, and the transport's session when it was seen.
  const [seen, setSeen] = useState<{ state: SharedChannelState; epoch: number | undefined }>({ state: 'unheld', epoch: undefined });
  const channelState = seen.state;
  const [refusedHere, setRefusedHere] = useState(false);
  useEffect(() => {
    setRefusedHere(false);
    if (!transport || !channel) { setSeen({ state: 'unheld', epoch: undefined }); return undefined; }
    setSeen({ state: transport.channelState(channel), epoch: transport.sessionEpoch });
    const offState = transport.onChannelState((c, state) => {
      if (c !== channel) return;
      setSeen({ state, epoch: transport.sessionEpoch });
      if (state === 'pending') setRefusedHere(false); // a re-sent subscribe awaits a new answer
    });
    const offFrames = transport.onMessage((frame) => {
      const refuses = latest.current.options.isRefusal;
      if (refuses && isRecord(frame) && refuses(frame)) setRefusedHere(true);
    });
    return () => { offState(); offFrames(); };
  }, [transport, channel]);

  const sessionEpoch = socket?.sessionEpoch;
  const live = enabled && !!transport && connectionState === 'connected'
    && (!channel || (channelState === 'subscribed' && !refusedHere
      && (sessionEpoch === undefined || seen.epoch === sessionEpoch)));
  const hidden = useDocumentHidden();

  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const controller = useRef<LiveRefresh | null>(null);
  const state = useRef({ live, hidden });
  state.current = { live, hidden };

  // Start over on a new record (channel / key).
  const key = options.key;
  useEffect(() => {
    setData(undefined);
    setError(undefined);
  }, [channel, key, enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    const ctl = createLiveRefresh<T>({
      read: (signal) => latest.current.read(signal),
      coalesceMs, livePollMs, pollMs, maxBackoff,
      live: state.current.live,
      hidden: state.current.hidden,
      onData: (value) => { setData(value); setError(undefined); latest.current.options.onData?.(value); },
      onError: (err) => { setError(err); latest.current.options.onError?.(err); },
    });
    controller.current = ctl;
    return () => {
      ctl.dispose();
      if (controller.current === ctl) controller.current = null;
    };
  }, [enabled, channel, key, coalesceMs, livePollMs, pollMs, maxBackoff]);

  useEffect(() => { controller.current?.setLive(live); }, [live]);
  useEffect(() => { controller.current?.setHidden(hidden); }, [hidden]);

  // Frames → hints.
  useEffect(() => {
    if (!transport || !enabled) return undefined;
    return transport.onMessage((frame) => {
      if (!isRecord(frame)) return;
      const isHint = latest.current.options.isHint;
      const counts = isHint ? isHint(frame) : !!channel && frame.channel === channel && !isControlFrame(frame);
      if (counts) controller.current?.hint();
    });
  }, [transport, enabled, channel]);

  const [refresh] = useState(() => () => controller.current?.refresh());
  return {
    data,
    error,
    loading: enabled && data === undefined && error === undefined,
    live,
    connectionState,
    channelState,
    refresh,
  };
}
