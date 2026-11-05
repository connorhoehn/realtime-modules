// test/contract/public-types.test.ts
//
// A type named in an exported signature must be importable from a published
// entry point.
//
// The failure this guards is quiet: TypeScript happily emits a .d.ts that
// mentions a module-local type, so the build is green, the signature reads
// fine in an editor, and the type is simply unnameable. A consumer can still
// pass an object literal — structural typing does not care — but cannot
// declare a variable, write a factory, or type the prop they forward it to.
// There is no error message anywhere; the API just resists being built on.
//
// Every import below was unreachable from any subpath in package.json
// `exports` before this file existed. Deep imports do not rescue them: there
// is no `./client/*` wildcard, so `.../client/useWebSocket` is blocked by the
// exports map.
//
// Like contract-conformance.test.ts, the assertions here are the types — the
// runtime block is deliberately trivial. If one of these stops being exported,
// this file fails to compile.

import { describe, it, expect } from '@jest/globals';

// ./client — the persist option's shape, the agent step, the canvas form.
import type {
  UseWebSocketPersistConfig,
  AgentStep,
  UnsupportedForm,
} from '../../src/client';

// ./client/ws — the Yjs-free surface exposes the same persist option.
import type { UseWebSocketPersistConfig as WsPersistConfig } from '../../src/client/ws';

// ./agent-streaming/client — useAgentStream returns steps: AgentStep[].
import type { AgentStep as StreamStep } from '../../src/agent-streaming/client';

// ./client/pipelines — the element type of PipelineRunSnapshot.steps.
import type { PipelineSnapshotStep } from '../../src/client/pipelines';

// ./client/video — the `log` option on every transport helper.
import type { TransportLog } from '../../src/client/video';

// ./fileupload — the two contracts a consumer must satisfy to construct the
// service, and the status union its rows carry.
import type {
  FileUploadMessageRouter,
  FileUploadLogger,
  FileUploadStatus,
} from '../../src/fileupload';

// ./room — carried on an announce frame's `event` field.
import type { RoomAnnounceEvent } from '../../src/room';

// ./server — CRDTServiceOpts.awarenessLedger is one of these.
import { AwarenessLedger, type ClientMessageFilter } from '../../src/server';

// --- The assertions -------------------------------------------------------
// Each declaration below fails to compile if the type is not exported, and
// fails to compile if its shape drifts from what the signature needs.

const persist: UseWebSocketPersistConfig = { storage: {} as Storage, keyPrefix: 'app_' };
const wsPersist: WsPersistConfig = persist;

const step: AgentStep = {} as AgentStep;
const streamStep: StreamStep = step;

const unsupported: UnsupportedForm = {} as UnsupportedForm;
const snapshotStep: PipelineSnapshotStep = { stepId: 's-1', status: 'running' };
const log: TransportLog = (msg: string) => void msg;
const recipientFilter: ClientMessageFilter = async ({ message }) => message;

// Structural, so a consumer's own object satisfies it — which is the point:
// they need the name to declare one.
const router: FileUploadMessageRouter = {
  sendToClient: () => undefined,
  sendToChannel: () => undefined,
};
const logger: FileUploadLogger = { info: () => undefined };
const status: FileUploadStatus = 'completed';

const announce: RoomAnnounceEvent = {} as RoomAnnounceEvent;

// ./client/pipelines + ./client/ws — the shared socket transport (0.144.0).
// Its adapters must satisfy the hook's transport and ui-components'
// EventStreamChannelTransport structurally; the latter is restated here
// because this package does not depend on ui-components.
import type {
  SharedSocketTransport,
  SharedPipelineRunTransport,
  SharedChannelTransport,
  PipelineRunTransport,
} from '../../src/client/pipelines';
import type { SharedSocketTransport as WsSharedSocketTransport, SharedSocketBinding, UseWebSocketHookReturn } from '../../src/client/ws';
interface UiEventStreamChannelTransport { subscribe(channel: string): void; unsubscribe(channel: string): void }
const sharedAdapters = (t: SharedSocketTransport): [PipelineRunTransport, UiEventStreamChannelTransport, WsSharedSocketTransport] =>
  [t.asPipelineRunTransport() satisfies SharedPipelineRunTransport, t.asChannelTransport() satisfies SharedChannelTransport, t];
const bindsUseWebSocket = (ws: UseWebSocketHookReturn): SharedSocketBinding => ws;

// ./client, ./client/ws, ./client/pipelines — live refresh (0.145.0). The
// provider's value is a useLiveRefresh socket; the core's options take the
// hook's numbers; a channel's state is one of four.
import type {
  LiveRefresh,
  LiveRefreshOptions,
  LiveRefreshTimers,
  UseLiveRefreshOptions,
  UseLiveRefreshResult,
  LiveRefreshSocket,
  SharedSocketContextValue,
  SharedSocketProviderProps,
  SharedChannelState,
} from '../../src/client';
import type { LiveRefreshSocket as WsLiveRefreshSocket, UseLiveRefreshResult as WsUseLiveRefreshResult } from '../../src/client/ws';
import type { UseLiveRefreshOptions as PipelinesUseLiveRefreshOptions, SharedChannelState as PipelinesChannelState } from '../../src/client/pipelines';
const contextIsSocket = (v: SharedSocketContextValue): [LiveRefreshSocket, WsLiveRefreshSocket] => [v, v];
const studioOptions: UseLiveRefreshOptions<{ id: string }> & PipelinesUseLiveRefreshOptions<{ id: string }> = {
  channel: 'studio:project:p1',
  isHint: (f) => f.type === 'studio.work.changed',
  coalesceMs: 100,
  pollMs: 15_000,
};
const coreOptions: LiveRefreshOptions<{ id: string }> = {
  read: async () => ({ id: 'p1' }),
  coalesceMs: studioOptions.coalesceMs,
  pollMs: studioOptions.pollMs,
  livePollMs: 0,
  maxBackoff: 5,
  now: () => 0,
  timers: { setTimeout: () => 0, clearTimeout: () => undefined } satisfies LiveRefreshTimers,
};
const channelStates: Array<SharedChannelState & PipelinesChannelState> = ['unheld', 'pending', 'subscribed', 'refused'];
const resultShape = (r: UseLiveRefreshResult<number>): WsUseLiveRefreshResult<number> => r;
const controlShape = (c: LiveRefresh): Array<keyof LiveRefresh> => Object.keys(c) as Array<keyof LiveRefresh>;
const providerModes: SharedSocketProviderProps[] = [
  { options: { url: 'ws://x' } },
  { fromGateway: true },
];

describe('public types are importable from published entry points', () => {
  it('holds the imports above (the assertions are the types)', () => {
    expect(persist.keyPrefix).toBe('app_');
    expect(wsPersist).toBe(persist);
    expect(streamStep).toBe(step);
    expect(snapshotStep.stepId).toBe('s-1');
    expect(status).toBe('completed');
    expect(typeof log).toBe('function');
    expect(typeof recipientFilter).toBe('function');
    expect(typeof router.sendToClient).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(AwarenessLedger).toBeDefined();
    expect(unsupported).toBeDefined();
    expect(announce).toBeDefined();
    expect(typeof sharedAdapters).toBe('function');
    expect(typeof bindsUseWebSocket).toBe('function');
    expect(typeof contextIsSocket).toBe('function');
    expect(studioOptions.coalesceMs).toBe(100);
    expect(coreOptions.livePollMs).toBe(0);
    expect(channelStates).toHaveLength(4);
    expect(typeof resultShape).toBe('function');
    expect(typeof controlShape).toBe('function');
    expect(providerModes).toHaveLength(2);
  });
});
