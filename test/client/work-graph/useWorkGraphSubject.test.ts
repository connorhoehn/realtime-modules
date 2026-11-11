/** @jest-environment jsdom */
// 0.147 (G3b): useWorkGraph scoped to a subject (`show:<id>`), no day window.

import { act, renderHook, waitFor } from '@testing-library/react';
import { jest } from '@jest/globals';
import { TextEncoder as NodeTextEncoder } from 'node:util';

import { workGraphSubjectScope, type ViewerWorkNode, type WorkGraphSnapshot } from '../../../src/work-graph/contracts';
import { createSnapshotDiffSource } from '../../../src/work-graph/snapshotDiffSource';
import { createAuthorityScope } from '../../../src/server-ws/authorityScope';
import {
  normalizeWorkGraphClientScope,
  useWorkGraph,
  type WorkGraphClientTransport,
  type WorkGraphSocketRequest,
} from '../../../src/client/work-graph/useWorkGraph';

Object.defineProperty(globalThis, 'TextEncoder', { value: NodeTextEncoder, configurable: true });

const at = '2026-11-08T10:00:00.000Z';
const character = (id: string): ViewerWorkNode => ({
  id, kind: 'subject', subjectKind: 'character', title: id, status: 'idle', disclosure: 'summary', updatedAt: at, capabilities: [],
});
function showSnapshot(subject: string, nodes: ViewerWorkNode[], watermark = 1): WorkGraphSnapshot {
  return {
    schemaVersion: 1, scope: { ...workGraphSubjectScope(subject), policyRevision: 'r1' },
    revision: watermark, watermark, cursor: `cursor_${subject}_${nodes.length}`, nodes, edges: [], sources: [], partial: false,
  };
}

function harness(responses: unknown[]) {
  let n = 0;
  const sockets: WorkGraphSocketRequest[] = [];
  const fetchSnapshot = jest.fn<WorkGraphClientTransport['fetchSnapshot']>(async () => responses[n++]);
  const transport: WorkGraphClientTransport = {
    fetchSnapshot,
    openWebSocket(request) { sockets.push(request); return { close: jest.fn() }; },
  };
  return { transport, fetchSnapshot, sockets };
}

describe('useWorkGraph — subject scope (0.147)', () => {
  test('expands a subject scope, applies its snapshot and the diff source\'s deltas', async () => {
    const first = showSnapshot('show:moon', [character('mina')]);
    const h = harness([first]);
    const { result } = renderHook(() => useWorkGraph({
      scope: { viewerId: 'me', subject: 'show:moon' },
      transport: h.transport,
      createSubscriptionGeneration: () => 'gen_1',
    }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(h.fetchSnapshot.mock.calls[0][0].scope).toEqual({ viewerId: 'me', ...workGraphSubjectScope('show:moon') });
    expect(h.sockets[0].scope.subject).toBe('show:moon');
    expect(result.current.graph.scope).toEqual(workGraphSubjectScope('show:moon'));
    expect(result.current.graph.nodes.mina.subjectKind).toBe('character');

    // The server half: the generic diff source answers a change with a delta
    // this hook applies.
    let current = first;
    const source = createSnapshotDiffSource({ snapshot: () => current });
    const sub = { clientId: 'c', userContext: null, channel: 'ch', scope: workGraphSubjectScope('show:moon'), subscriptionGeneration: 'gen_1', cursor: first.cursor };
    await source.frames(sub, { reason: 'subscribe' }, { scope: createAuthorityScope('t') });
    current = showSnapshot('show:moon', [character('mina'), character('toby')]);
    const [frame] = await source.frames(sub, { reason: 'change', change: null }, { scope: createAuthorityScope('t') });
    act(() => h.sockets[0].onMessage(frame));
    expect(Object.keys(result.current.graph.nodes).sort()).toEqual(['mina', 'toby']);
    expect(result.current.graph.watermark).toBe(2);
  });

  test('refuses a snapshot for another subject, and a person-day scope behaves as before', async () => {
    const h = harness([showSnapshot('show:sun', [character('x')])]);
    const { result } = renderHook(() => useWorkGraph({ scope: { viewerId: 'me', subject: 'show:moon' }, transport: h.transport }));
    await waitFor(() => expect(result.current.error).toBe('invalid-snapshot'));

    const personDay = { viewerId: 'me', personId: 'p', day: '2026-11-08', timezone: 'UTC' };
    expect(normalizeWorkGraphClientScope(personDay)).toBe(personDay);
    expect(normalizeWorkGraphClientScope({ viewerId: 'me', subject: 'show:moon' })).toEqual({ viewerId: 'me', ...workGraphSubjectScope('show:moon') });
  });

  test('schemaVersion 2 sends a subject query over any window', async () => {
    const h = harness([new Promise(() => undefined)]);
    renderHook(() => useWorkGraph({
      scope: { viewerId: 'me', subject: 'show:moon' }, transport: h.transport, schemaVersion: 2,
      window: { start: '2026-10-01T00:00:00.000Z', end: at },
    }));
    await waitFor(() => expect(h.fetchSnapshot).toHaveBeenCalledTimes(1));
    expect(h.fetchSnapshot.mock.calls[0][0].activity).toMatchObject({ schemaVersion: 2, windowStart: '2026-10-01T00:00:00.000Z', windowEnd: at });
  });
});
