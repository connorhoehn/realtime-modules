// realtime-modules/src/client/sharedSocketTransport.ts
//
// One host-owned WebSocket shared by several consumers (v0.144.0).
//
// `useWebSocket` takes a single `onMessage`, and the server keeps ONE
// subscription per socket and channel. An app that owns its socket and hands
// it to several consumers — `usePipelineRunStatus` instances, ui-components'
// `EventStreamProvider` (`channelTransport`), its own frame handler — needs
// three things the bare socket does not give it:
//
//   1. fan-out: every inbound frame reaches every registered handler;
//   2. reference-counted channels: the first holder sends the subscribe frame,
//      the last release sends the unsubscribe, so two views of one run do not
//      unsubscribe each other;
//   3. re-subscription: a new session epoch is a new server connection that
//      has subscribed to nothing, so every held channel is sent again, once.
//
// Frames are the server's: `{ service: 'pipeline' | 'subscribe', action:
// 'subscribe' | 'unsubscribe', channel }`. `pipeline:*` channels default to the
// `pipeline` service (the `pipeline()` feature's gate); anything else to the
// generic `subscribe` service. Since 0.143.0 the `subscribe` service defers
// `pipeline:` channels to the pipeline feature, so either route reaches the
// same gate.
//
// Framework-free: the React binding is `useSharedSocketTransport` /
// `useSharedWebSocket` (./useSharedSocketTransport).

/** The service that owns a channel's subscribe / unsubscribe frames. */
export type SharedSocketChannelService = 'pipeline' | 'subscribe';

/** An outbound frame as the socket's `send` takes it. */
export type SharedSocketFrame = Record<string, unknown>;

export interface SharedSocketTransportOptions {
  /** The socket's send (`useWebSocket().send`). Omitted: frames are dropped and subscriptions held until `update({ send })`. */
  send?: (frame: SharedSocketFrame) => void;
  /**
   * The socket's session epoch (`useWebSocket().sessionEpoch`). `0` means no
   * session yet: subscriptions are held, not sent. Each new value re-sends
   * every held channel once. Undefined: no session tracking — a channel is
   * sent on its first hold and the socket's lifecycle is the owner's.
   */
  sessionEpoch?: number;
  /** Extra gate on subscription frames, e.g. `() => ws.connectionState === 'connected'`. Call `resubscribe()` when it turns true. */
  isOpen?: () => boolean;
  /**
   * When a last release's unsubscribe is sent. Default `queueMicrotask`: a
   * release followed by a hold of the same channel in the same tick (React
   * re-running an effect, or every consumer re-running on a new epoch) sends
   * nothing. Pass `(flush) => flush()` to send it immediately.
   */
  scheduleRelease?: (flush: () => void) => void;
  /** A handler threw while a frame was fanned out. Default `console.error`. The other handlers still run. */
  onHandlerError?: (error: unknown, frame: unknown) => void;
}

export interface SharedSocketSubscribeOptions {
  /** Default: `'pipeline'` for `pipeline:*` channels, else `'subscribe'`. The first holder's service is used while the channel is held. */
  service?: SharedSocketChannelService;
}

/**
 * The `{ send, onMessage }` shape `usePipelineRunStatus` / `usePipelineCatalog`
 * take as `transport` (structurally `PipelineRunTransport`). Subscribe and
 * unsubscribe frames sent through it become holds and releases on the shared
 * transport, so they must be paired — the library hooks pair them.
 */
export interface SharedPipelineRunTransport {
  send: (frame: unknown) => void;
  onMessage: (fn: (frame: unknown) => void) => () => void;
}

/**
 * The `{ subscribe, unsubscribe }` shape ui-components' `EventStreamProvider`
 * takes as `channelTransport` (structurally `EventStreamChannelTransport`).
 * Stable identity: re-subscription after a reconnect is the shared
 * transport's job, so the provider's subscribers never re-run for it.
 */
export interface SharedChannelTransport {
  subscribe: (channel: string) => void;
  unsubscribe: (channel: string) => void;
}

/**
 * Where a held channel stands with the server in the current session (0.145.0):
 *
 * - `'unheld'`: nobody holds it;
 * - `'pending'`: held, the subscribe not sent yet or not answered — the
 *   server's catalog treats silence as refusal, so this is not "probably fine";
 * - `'subscribed'`: acknowledged (`{ action: 'subscribed', channel }` from the
 *   `subscribe` service or the `pipeline()` feature);
 * - `'refused'`: an `{ type: 'error', channel }` frame named it
 *   (`PIPELINE_CHANNEL_REFUSED`, `AUTHZ_CHANNEL_DENIED`, …).
 *
 * A new session epoch puts every held channel back to `'pending'`.
 */
export type SharedChannelState = 'unheld' | 'pending' | 'subscribed' | 'refused';

export interface SharedSocketTransport {
  /** Hand every inbound frame here — pass it as the socket's `onMessage`. Stable. */
  deliver: (frame: unknown) => void;
  /** Register a handler for every inbound frame. Returns the unregister. */
  onMessage: (handler: (frame: unknown) => void) => () => void;
  /** Hold a channel. The first hold sends the subscribe frame; the returned release (idempotent) lets go, and the last release sends the unsubscribe. */
  subscribe: (channel: string, options?: SharedSocketSubscribeOptions) => () => void;
  /** Send a frame as is (no refcounting). Dropped while there is no `send`. */
  send: (frame: SharedSocketFrame) => void;
  /** Re-bind the socket. A changed `sessionEpoch` re-sends every held channel. */
  update: (options: Pick<SharedSocketTransportOptions, 'send' | 'sessionEpoch' | 'isOpen'>) => void;
  /** Re-send the subscribe frame of every held channel (for an `isOpen` host whose socket just opened). */
  resubscribe: () => void;
  /** Send the pending last-release unsubscribes now. */
  flush: () => void;
  /** The epoch last given, or undefined. */
  readonly sessionEpoch: number | undefined;
  /** Held channels and their hold counts. */
  holds: () => Map<string, number>;
  /** Where `channel` stands in this session: see `SharedChannelState`. Read from the acks and refusals passed to `deliver`. */
  channelState: (channel: string) => SharedChannelState;
  /** Called with `(channel, state)` whenever a channel's state changes. Returns the unregister. */
  onChannelState: (handler: (channel: string, state: SharedChannelState) => void) => () => void;
  /** The `{ send, onMessage }` adapter for the pipeline hooks. One per transport. */
  asPipelineRunTransport: () => SharedPipelineRunTransport;
  /** The `{ subscribe, unsubscribe }` adapter for `EventStreamProvider`. One per transport. */
  asChannelTransport: () => SharedChannelTransport;
}

/** `'pipeline'` for `pipeline:*` channels, else `'subscribe'`. */
export function defaultChannelService(channel: string): SharedSocketChannelService {
  return channel.startsWith('pipeline:') ? 'pipeline' : 'subscribe';
}

interface Held {
  count: number;
  service: SharedSocketChannelService;
  /** The session the subscribe frame was sent in; `null` when not sent. */
  sentIn: number | null;
  /** The server's answer in this session. */
  state: 'pending' | 'subscribed' | 'refused';
}

// The session key when the host gives no epoch.
const UNTRACKED = -1;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

/**
 * An error frame refusing a subscribe: `PIPELINE_CHANNEL_REFUSED`, or the
 * router's `AUTHZ_CHANNEL_DENIED` with `kind: 'subscribe'` (a refused publish
 * on a channel leaves the subscription alone), or an error naming the channel
 * with neither code nor kind.
 */
function isSubscribeRefusal(f: Record<string, unknown>): boolean {
  if (f.type !== 'error') return false;
  if (f.code === 'PIPELINE_CHANNEL_REFUSED') return true;
  if (f.code === 'AUTHZ_CHANNEL_DENIED') return f.kind === undefined || f.kind === 'subscribe';
  return f.code === undefined && f.kind === undefined;
}

/** One host socket, shared: fan-out, refcounted channels, re-subscription per session epoch. */
export function createSharedSocketTransport(options: SharedSocketTransportOptions = {}): SharedSocketTransport {
  let send = options.send;
  let epoch = options.sessionEpoch;
  let isOpen = options.isOpen;
  const scheduleRelease = options.scheduleRelease ?? ((fn: () => void) => queueMicrotask(fn));
  const onHandlerError = options.onHandlerError ?? ((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[realtime-modules] shared socket handler threw', error);
  });

  const handlers = new Set<(frame: unknown) => void>();
  const stateHandlers = new Set<(channel: string, state: SharedChannelState) => void>();
  const notify = (channel: string, state: SharedChannelState) => {
    for (const fn of [...stateHandlers]) {
      try { fn(channel, state); } catch (err) { onHandlerError(err, { channel, state }); }
    }
  };
  const setState = (channel: string, h: Held, state: Held['state']) => {
    if (h.state === state) return;
    h.state = state;
    notify(channel, state);
  };
  const held = new Map<string, Held>();
  const pending = new Set<string>();
  let flushScheduled = false;

  const sessionKey = () => (epoch === undefined ? UNTRACKED : epoch);
  const canSubscribe = () => !!send && epoch !== 0 && (isOpen ? isOpen() : true);
  const frame = (h: Held, action: 'subscribe' | 'unsubscribe', channel: string): SharedSocketFrame =>
    ({ service: h.service, action, channel });

  const sendSubscribe = (channel: string, h: Held) => {
    if (h.sentIn === sessionKey() || !canSubscribe()) return;
    h.sentIn = sessionKey();
    // A (re-)sent subscribe awaits a fresh answer.
    setState(channel, h, 'pending');
    send!(frame(h, 'subscribe', channel));
  };

  const flush = () => {
    flushScheduled = false;
    const channels = [...pending];
    pending.clear();
    for (const channel of channels) {
      const h = held.get(channel);
      if (!h || h.count > 0) continue;
      held.delete(channel);
      notify(channel, 'unheld');
      // Only a channel this session subscribed needs leaving.
      if (h.sentIn === sessionKey() && canSubscribe()) send!(frame(h, 'unsubscribe', channel));
    }
  };

  const subscribe = (channel: string, opts?: SharedSocketSubscribeOptions) => {
    let h = held.get(channel);
    if (!h) {
      h = { count: 0, service: opts?.service ?? defaultChannelService(channel), sentIn: null, state: 'pending' };
      held.set(channel, h);
      notify(channel, 'pending');
    }
    h.count += 1;
    pending.delete(channel);
    sendSubscribe(channel, h);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = held.get(channel);
      if (!cur) return;
      cur.count -= 1;
      if (cur.count > 0) return;
      pending.add(channel);
      if (!flushScheduled) {
        flushScheduled = true;
        scheduleRelease(flush);
      }
    };
  };

  const resubscribe = () => {
    for (const [channel, h] of held) {
      if (h.count > 0) sendSubscribe(channel, h);
    }
  };

  const update: SharedSocketTransport['update'] = (next) => {
    if ('send' in next) send = next.send;
    if ('isOpen' in next) isOpen = next.isOpen;
    if (!('sessionEpoch' in next) || next.sessionEpoch === epoch) {
      resubscribe();
      return;
    }
    epoch = next.sessionEpoch;
    // A new connection: what the old one was subscribed to is gone with it.
    for (const [channel, h] of [...held]) {
      h.sentIn = null;
      if (h.count === 0) { held.delete(channel); pending.delete(channel); notify(channel, 'unheld'); continue; }
      setState(channel, h, 'pending');
    }
    resubscribe();
  };

  // Acks and refusals of held channels, whichever service sent them.
  const track = (inbound: unknown) => {
    if (!isObject(inbound) || typeof inbound.channel !== 'string') return;
    const h = held.get(inbound.channel);
    if (!h || h.count === 0) return;
    if (inbound.action === 'subscribed' && inbound.type !== 'error') setState(inbound.channel, h, 'subscribed');
    else if (isSubscribeRefusal(inbound)) setState(inbound.channel, h, 'refused');
  };

  const deliver = (inbound: unknown) => {
    track(inbound);
    for (const fn of [...handlers]) {
      try { fn(inbound); } catch (err) { onHandlerError(err, inbound); }
    }
  };

  const onMessage = (fn: (frame: unknown) => void) => {
    handlers.add(fn);
    return () => { handlers.delete(fn); };
  };

  const sendRaw = (out: SharedSocketFrame) => { send?.(out); };

  // Releases taken through an adapter, per channel, newest last.
  const adapterHolds = () => {
    const releases = new Map<string, Array<() => void>>();
    return {
      hold(channel: string, service?: SharedSocketChannelService) {
        const list = releases.get(channel) ?? [];
        list.push(subscribe(channel, service ? { service } : undefined));
        releases.set(channel, list);
      },
      release(channel: string) {
        const list = releases.get(channel);
        const release = list?.pop();
        if (list && list.length === 0) releases.delete(channel);
        // An unsubscribe nobody here held is dropped: forwarding it would
        // unsubscribe another consumer's channel.
        release?.();
      },
    };
  };

  let pipelineAdapter: SharedPipelineRunTransport | undefined;
  let channelAdapter: SharedChannelTransport | undefined;

  const transport: SharedSocketTransport = {
    deliver,
    onMessage,
    subscribe,
    send: sendRaw,
    update,
    resubscribe,
    flush,
    get sessionEpoch() { return epoch; },
    holds: () => new Map([...held].filter(([, h]) => h.count > 0).map(([c, h]) => [c, h.count])),
    channelState(channel: string): SharedChannelState {
      const h = held.get(channel);
      return h && h.count > 0 ? h.state : 'unheld';
    },
    onChannelState(fn) {
      stateHandlers.add(fn);
      return () => { stateHandlers.delete(fn); };
    },
    asPipelineRunTransport() {
      if (pipelineAdapter) return pipelineAdapter;
      const holds = adapterHolds();
      pipelineAdapter = {
        send(out: unknown) {
          if (isObject(out) && (out.service === 'pipeline' || out.service === 'subscribe')
            && typeof out.channel === 'string' && out.channel
            && (out.action === 'subscribe' || out.action === 'unsubscribe')) {
            if (out.action === 'subscribe') holds.hold(out.channel, out.service);
            else holds.release(out.channel);
            return;
          }
          if (isObject(out)) sendRaw(out);
        },
        onMessage,
      };
      return pipelineAdapter;
    },
    asChannelTransport() {
      if (channelAdapter) return channelAdapter;
      const holds = adapterHolds();
      channelAdapter = {
        subscribe: (channel: string) => holds.hold(channel),
        unsubscribe: (channel: string) => holds.release(channel),
      };
      return channelAdapter;
    },
  };
  return transport;
}
