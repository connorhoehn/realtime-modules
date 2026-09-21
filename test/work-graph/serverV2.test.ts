import { describe, expect, it } from '@jest/globals';
import type { ViewerWorkEdge, ViewerWorkNode, WorkGraphSnapshot } from '../../src/work-graph/contracts';
import type { WorkGraphQueryV2 } from '../../src/work-graph/contractsV2';
import {
  bucketWorkEvents,
  buildWorkGraphSnapshotV2,
  deriveWorkEfforts,
  detailsForDisclosedNodes,
  freshWorkOperations,
} from '../../src/work-graph/serverV2';

const day = '2026-09-21';
const timezone = 'America/New_York';
const at = (time: string) => `2026-09-21T${time}.000Z`;

function node(id: string, kind: ViewerWorkNode['kind'], title: string, updatedAt: string, extra: Partial<ViewerWorkNode> = {}): ViewerWorkNode {
  return { id, kind, title, status: 'completed', disclosure: 'details', updatedAt, capabilities: [], ...extra };
}

function edge(id: string, fromId: string, toId: string, relation: ViewerWorkEdge['relation']): ViewerWorkEdge {
  return { id, fromId, toId, relation, status: 'completed', disclosure: 'details', updatedAt: at('13:30:00'), capabilities: [] };
}

const nodes = [
  node('meeting', 'meeting', 'Planning sync', at('12:30:00')),
  node('transcript', 'transcript', 'Transcript', at('12:40:00')),
  node('run', 'run', 'Generate presentation', at('13:30:00')),
  node('deck', 'document', 'Sprint review', at('13:35:00')),
  node('project', 'project', 'WORK-144', at('13:20:00')),
  node('terminal', 'terminal', 'Cloud terminal', at('13:25:00')),
  node('loose', 'document', 'Unrelated note', at('13:36:00')),
];
const edges = [
  edge('e1', 'transcript', 'meeting', 'derived-from'),
  edge('e2', 'run', 'transcript', 'derived-from'),
  edge('e3', 'run', 'deck', 'produced'),
  edge('e4', 'terminal', 'project', 'works-on'),
];

describe('shared v2 server helpers', () => {
  it('groups only what the sources related, and leaves unreachable work ungrouped', () => {
    const efforts = deriveWorkEfforts({ nodes, edges });
    expect(efforts).toHaveLength(2);
    // Newest anchor first: the project was updated after the meeting.
    expect(efforts.map((effort) => effort.anchorNodeId)).toEqual(['project', 'meeting']);
    const sprint = efforts.find((effort) => effort.anchorNodeId === 'meeting');
    expect(sprint?.nodeIds.sort()).toEqual(['deck', 'meeting', 'run', 'transcript']);
    expect(sprint?.edgeIds.sort()).toEqual(['e1', 'e2', 'e3']);
    // Named by the newest outcome the viewer may see, not by the anchor.
    expect(sprint?.title).toBe('Sprint review');
    expect(efforts.find((effort) => effort.anchorNodeId === 'project')?.title).toBe('WORK-144');
    // A document with no declared relationship joins no effort at all.
    expect(efforts.flatMap((effort) => effort.nodeIds)).not.toContain('loose');
  });

  it('never names an effort after a member the viewer cannot read', () => {
    const hidden = nodes.map((item) => item.id === 'deck'
      ? { ...item, disclosure: 'existence' as const, locked: true }
      : item);
    const sprint = deriveWorkEfforts({ nodes: hidden, edges }).find((effort) => effort.anchorNodeId === 'meeting');
    expect(sprint?.title).toBe('Planning sync');
    expect(sprint?.nodeIds).toContain('deck');
  });

  it('reports pre-window members as folded context without dropping membership', () => {
    const sprint = deriveWorkEfforts({ nodes, edges, contextBefore: at('13:00:00') })
      .find((effort) => effort.anchorNodeId === 'meeting');
    expect(sprint?.contextNodeIds).toEqual(['transcript']);
    expect(sprint?.nodeIds).toContain('transcript');
  });

  it('assigns each node to one effort even when anchors are related to each other', () => {
    const linked = [...edges, edge('e5', 'project', 'meeting', 'works-on')];
    const efforts = deriveWorkEfforts({ nodes, edges: linked });
    expect(efforts).toHaveLength(1);
    expect(efforts[0].anchorNodeId).toBe('project');
  });

  it('builds and strictly validates a v2 snapshot, rejecting unsupported activity', () => {
    const query: WorkGraphQueryV2 = {
      schemaVersion: 2, personId: 'owner', day, timezone,
      windowStart: at('13:20:00'), windowEnd: at('13:40:00'), mode: 'live',
    };
    const snapshot: WorkGraphSnapshot = {
      schemaVersion: 1,
      scope: { personId: 'owner', day, timezone, policyRevision: 'policy-1' },
      revision: 4, watermark: 4, cursor: 'opaque', nodes, edges, sources: [], partial: false,
    };
    const activity = {
      temporal: { mode: 'live' as const, observedAt: at('13:40:00'), coverage: { from: at('12:00:00'), through: at('13:40:00'), complete: true } },
      efforts: deriveWorkEfforts({ nodes, edges, contextBefore: query.windowStart }),
      details: [{ nodeId: 'run', summary: 'Presentation agent · 3 tools', tools: ['Slides', 'Charts', 'Files'] }],
      operations: [{ edgeId: 'e3', processNodeId: 'run', attemptId: 'attempt-3', observedAt: at('13:38:00'), expiresAt: at('13:41:00') }],
      eventBuckets: [{ at: at('13:30:00'), count: 2 }],
    };
    expect(buildWorkGraphSnapshotV2({ snapshot, query, activity }).ok).toBe(true);
    // A detail for a node that is not in the snapshot is a contract violation.
    const bad = buildWorkGraphSnapshotV2({
      snapshot, query,
      activity: { ...activity, details: [{ nodeId: 'not-a-node' }] },
    });
    expect(bad.ok).toBe(false);
  });

  it('buckets observations inside the real local day and drops everything else', () => {
    const buckets = bucketWorkEvents({ day, timezone }, [
      { at: at('13:30:10') }, { at: at('13:30:50') }, { at: at('13:31:00'), count: 3 },
      { at: '2026-09-20T03:00:00.000Z' }, { at: 'not-a-time' }, { at: at('13:45:00') },
    ], { observedAt: at('13:40:00') });
    expect(buckets).toEqual([
      { at: at('13:30:00'), count: 2 },
      { at: at('13:31:00'), count: 3 },
    ]);
  });

  it('drops expired operation leases and details for nodes below full disclosure', () => {
    const operations = [
      { edgeId: 'e3', processNodeId: 'run', attemptId: 'a', observedAt: at('13:38:00'), expiresAt: at('13:41:00') },
      { edgeId: 'e4', processNodeId: 'terminal', attemptId: 'b', observedAt: at('12:00:00'), expiresAt: at('12:01:00') },
    ];
    expect(freshWorkOperations(operations, at('13:40:00')).map((item) => item.edgeId)).toEqual(['e3']);
    const summarised = nodes.map((item) => item.id === 'run' ? { ...item, disclosure: 'summary' as const } : item);
    expect(detailsForDisclosedNodes(summarised, [{ nodeId: 'run' }, { nodeId: 'deck' }, { nodeId: 'deck' }]))
      .toEqual([{ nodeId: 'deck' }]);
  });
});
