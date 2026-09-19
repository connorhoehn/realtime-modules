import type { DisclosureDecision, WorkGraphPolicyInput, WorkProjectionState } from '../../src/work-graph/contracts';
import { activeSharingGrantFixture, workGraphFixtureIds } from '../../src/work-graph/fixtures';
import { filterForViewer } from '../../src/work-graph/filterForViewer';

const nodeA = workGraphFixtureIds.projectNode;
const nodeB = workGraphFixtureIds.terminalNode;
const edge = workGraphFixtureIds.edge;

const state = (): WorkProjectionState => ({
  schemaVersion: 1,
  organizationId: workGraphFixtureIds.organization,
  actorId: workGraphFixtureIds.owner,
  revision: 1,
  sessions: {},
  nodes: {
    [nodeA]: {
      id: nodeA, organizationId: workGraphFixtureIds.organization, actorId: workGraphFixtureIds.owner,
      kind: 'project', sourceRef: { source: 'cloud-compute', resourceId: 'private-project-resource' }, policyRef: 'project-policy',
      title: 'Secret Project Title', description: 'Private project description', status: 'running', updatedAt: '2026-09-19T14:00:00.000Z', sourceEventId: 'event-a', revision: 1,
    },
    [nodeB]: {
      id: nodeB, organizationId: workGraphFixtureIds.organization, actorId: workGraphFixtureIds.owner,
      kind: 'terminal', sourceRef: { source: 'cloud-compute', resourceId: 'private-terminal-resource' }, policyRef: 'terminal-policy',
      title: 'Secret Terminal Title', status: 'waiting', updatedAt: '2026-09-19T14:00:00.000Z', sourceEventId: 'event-b', revision: 1,
    },
  },
  edges: {
    [edge]: {
      id: edge, organizationId: workGraphFixtureIds.organization, actorId: workGraphFixtureIds.owner,
      fromId: nodeB, toId: nodeA, relation: 'works-on', policyRef: 'edge-policy', label: 'Private relationship',
      status: 'running', updatedAt: '2026-09-19T14:00:00.000Z', sourceEventId: 'event-edge', provenance: 'source-event', revision: 1,
    },
  },
  sourceCheckpoints: {},
  appliedEventIds: [],
});

const decision = (targetId: string, maximumDisclosure: DisclosureDecision['maximumDisclosure'] = 'summary'): DisclosureDecision => ({
  targetId,
  decision: 'allow',
  maximumDisclosure,
  capabilities: ['message'],
  policyRevision: 'policy-fixture-1',
});

const policy = (viewerId: string = workGraphFixtureIds.viewer, options: Partial<WorkGraphPolicyInput> = {}): WorkGraphPolicyInput => ({
  scope: {
    organizationId: workGraphFixtureIds.organization,
    viewerId,
    personId: workGraphFixtureIds.owner,
    day: '2026-09-19', timezone: 'America/New_York', policyRevision: 'policy-fixture-1',
  },
  grant: activeSharingGrantFixture,
  nodeDecisions: new Map([[nodeA, decision(nodeA)], [nodeB, decision(nodeB)]]),
  edgeDecisions: new Map([[edge, decision(edge)]]),
  ...options,
});

describe('filterForViewer', () => {
  test('projects an owner only from explicit allow decisions', () => {
    const graph = filterForViewer(state(), policy(workGraphFixtureIds.owner));
    expect(graph).toEqual({
      nodes: [
        expect.objectContaining({ id: nodeA, title: 'Secret Project Title', disclosure: 'summary' }),
        expect.objectContaining({ id: nodeB, title: 'Secret Terminal Title', disclosure: 'summary' }),
      ],
      edges: [expect.objectContaining({ id: edge, fromId: nodeB, toId: nodeA, relation: 'works-on' })],
    });
    expect(graph).not.toHaveProperty('counts');
    expect(graph).not.toHaveProperty('layout');
  });

  test('projects an allowed viewer but withholds summary-only descriptions and relationship labels', () => {
    const graph = filterForViewer(state(), policy());
    expect(graph.nodes[0]).not.toHaveProperty('description');
    expect(graph.edges[0]).not.toHaveProperty('label');
  });

  test('does not infer permission for an outsider', () => {
    const denied = new Map([[nodeA, { ...decision(nodeA), decision: 'deny' as const }], [nodeB, { ...decision(nodeB), decision: 'deny' as const }]]);
    const graph = filterForViewer(state(), policy(workGraphFixtureIds.outsider, { nodeDecisions: denied, edgeDecisions: new Map() }));
    expect(graph).toEqual({ nodes: [], edges: [] });
  });

  test('fails closed when the scope or grant belongs to another organization', () => {
    const graph = filterForViewer(state(), policy(undefined, {
      scope: { ...policy().scope, organizationId: 'org_other' },
      grant: { ...activeSharingGrantFixture, organizationId: 'org_other' },
    }));
    expect(graph).toEqual({ nodes: [], edges: [] });
  });

  test('removes a denied endpoint and its incident edge', () => {
    const nodeDecisions = new Map([[nodeA, decision(nodeA)], [nodeB, { ...decision(nodeB), decision: 'deny' as const }]]);
    const graph = filterForViewer(state(), policy(undefined, { nodeDecisions }));
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].id).toBe(nodeA);
    expect(graph.edges).toEqual([]);
  });

  test('requires a separately allowed relationship even when both endpoints are visible', () => {
    const graph = filterForViewer(state(), policy(undefined, { edgeDecisions: new Map([[edge, { ...decision(edge), decision: 'deny' as const }]]) }));
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([]);
  });

  test('denies missing, unavailable, stale, or mismatched decisions', () => {
    const missing = filterForViewer(state(), policy(undefined, {
      nodeDecisions: new Map([[nodeA, decision(nodeA)]]),
      edgeDecisions: new Map(),
    }));
    expect(missing).toEqual({ nodes: [expect.objectContaining({ id: nodeA })], edges: [] });

    const unavailable = { ...decision(nodeA), decision: 'unavailable' as const };
    const stale = { ...decision(nodeB), policyRevision: 'old-policy' };
    const graph = filterForViewer(state(), policy(undefined, {
      nodeDecisions: new Map([[nodeA, unavailable], [nodeB, stale]]),
      edgeDecisions: new Map([[edge, { ...decision(edge), targetId: 'another-edge' }]]),
    }));
    expect(graph).toEqual({ nodes: [], edges: [] });
  });

  test('uses only the explicit existence label for an existence-only placeholder', () => {
    const placeholder = { ...decision(nodeA, 'existence'), existenceLabel: 'A shared work item' };
    const graph = filterForViewer(state(), policy(undefined, {
      nodeDecisions: new Map([[nodeA, placeholder], [nodeB, decision(nodeB)]]),
    }));
    expect(graph.nodes[0]).toEqual({
      id: expect.stringMatching(/^wg_placeholder_[a-f0-9]{64}$/), kind: 'task', title: 'A shared work item', status: 'idle', updatedAt: '1970-01-01T00:00:00.000Z',
      disclosure: 'existence', capabilities: [], locked: true,
    });
    expect(JSON.stringify(graph.nodes[0])).not.toContain(nodeA);
    expect(JSON.stringify(graph.nodes[0])).not.toContain('Secret Project Title');
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ fromId: nodeB, toId: graph.nodes[0].id });
  });

  test('keeps a placeholder identity after another node is removed or reordered', () => {
    const nodeDecisions = new Map([nodeA, nodeB].map((id) => [id, { ...decision(id, 'existence'), existenceLabel: 'Shared work' }]));
    const allowed = policy(undefined, { nodeDecisions });
    const original = state();
    const before = filterForViewer(original, allowed);
    const reordered = { ...original, nodes: { [nodeB]: original.nodes[nodeB], [nodeA]: original.nodes[nodeA] } };
    expect(filterForViewer(reordered, allowed).nodes.map((node) => node.id)).toEqual([before.nodes[1].id, before.nodes[0].id]);
    const removed = { ...original, nodes: { [nodeB]: original.nodes[nodeB] } };
    expect(filterForViewer(removed, allowed).nodes[0].id).toBe(before.nodes[1].id);
  });

  test('does not reuse existence identities across viewers or policy revisions', () => {
    const nodeDecisions = new Map([[nodeA, { ...decision(nodeA, 'existence'), existenceLabel: 'Shared work' }]]);
    const firstPolicy = policy(undefined, { nodeDecisions });
    const first = filterForViewer(state(), firstPolicy).nodes[0].id;
    const second = filterForViewer(state(), policy('another-viewer', { nodeDecisions })).nodes[0].id;
    const nextPolicy = {
      ...firstPolicy,
      scope: { ...firstPolicy.scope, policyRevision: 'policy-2' },
      nodeDecisions: new Map([[nodeA, { ...nodeDecisions.get(nodeA)!, policyRevision: 'policy-2' }]]),
    };
    const third = filterForViewer(state(), nextPolicy).nodes[0].id;
    expect(new Set([first, second, third]).size).toBe(3);
  });
});
