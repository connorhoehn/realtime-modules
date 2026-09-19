import type {
  AuthenticatedWorkEvent,
  DisclosureDecision,
  WorkGraphQueryScope,
  WorkGraphSnapshot,
  WorkReference,
  WorkSharingGrant,
} from './contracts';

export const workGraphFixtureIds = {
  organization: 'org_active_now_fixture',
  owner: 'person_owner_fixture',
  viewer: 'person_viewer_fixture',
  outsider: 'person_outsider_fixture',
  projectNode: 'wg_node_project_fixture',
  terminalNode: 'wg_node_terminal_fixture',
  edge: 'wg_edge_runs_in_fixture',
  grant: 'wg_grant_fixture',
} as const;

export const validCloudEventFixture: AuthenticatedWorkEvent = {
  schemaVersion: 1,
  eventId: 'event_cloud_fixture_001',
  idempotencyKey: 'cloud:job_fixture:1:started',
  source: 'cloud-compute',
  sourceSequence: '1',
  occurredAt: '2026-09-19T14:00:00.000Z',
  receivedAt: '2026-09-19T14:00:01.000Z',
  actor: {
    actorId: workGraphFixtureIds.owner,
    organizationId: workGraphFixtureIds.organization,
    sourceSubject: 'orgiq-subject-owner-fixture',
  },
  producer: {
    serviceId: 'orgiq-middleware',
    organizationId: workGraphFixtureIds.organization,
    credentialId: 'service-key-fixture',
  },
  resource: { source: 'cloud-compute', resourceId: 'source-box-fixture' },
  payload: {
    kind: 'cloud-compute',
    lifecycle: 'started',
    boxId: 'source-box-fixture',
    jobId: 'source-job-fixture',
    projectId: 'source-project-fixture',
    attempt: 1,
    safeLabel: 'Run tests',
  },
};

export const activeSharingGrantFixture: WorkSharingGrant = {
  schemaVersion: 1,
  id: workGraphFixtureIds.grant,
  organizationId: workGraphFixtureIds.organization,
  ownerId: workGraphFixtureIds.owner,
  audience: { kind: 'people', personIds: [workGraphFixtureIds.viewer] },
  selection: {
    nodeIds: [workGraphFixtureIds.projectNode, workGraphFixtureIds.terminalNode],
    edgeIds: [workGraphFixtureIds.edge],
    disclosure: 'summary',
  },
  state: 'active',
  createdAt: '2026-09-19T13:55:00.000Z',
  updatedAt: '2026-09-19T13:55:00.000Z',
  expiresAt: '2026-09-19T21:55:00.000Z',
  revision: 1,
};

export const viewerScopeFixture: WorkGraphQueryScope = {
  organizationId: workGraphFixtureIds.organization,
  viewerId: workGraphFixtureIds.viewer,
  personId: workGraphFixtureIds.owner,
  day: '2026-09-19',
  timezone: 'America/New_York',
  policyRevision: 'policy-fixture-1',
};

export const outsiderScopeFixture: WorkGraphQueryScope = {
  ...viewerScopeFixture,
  viewerId: workGraphFixtureIds.outsider,
};

export const allowedDisclosureFixture: DisclosureDecision[] = [
  {
    targetId: workGraphFixtureIds.projectNode,
    decision: 'allow',
    maximumDisclosure: 'summary',
    capabilities: ['message'],
    policyRevision: 'policy-fixture-1',
  },
  {
    targetId: workGraphFixtureIds.terminalNode,
    decision: 'allow',
    maximumDisclosure: 'summary',
    capabilities: ['observe-terminal'],
    policyRevision: 'policy-fixture-1',
  },
  {
    targetId: workGraphFixtureIds.edge,
    decision: 'allow',
    maximumDisclosure: 'summary',
    capabilities: ['message'],
    policyRevision: 'policy-fixture-1',
  },
];

export const deniedDisclosureFixture: DisclosureDecision[] = allowedDisclosureFixture.map((item) => ({
  targetId: item.targetId,
  decision: 'deny',
  policyRevision: 'policy-fixture-1',
}));

export const nodeReferenceFixture: WorkReference = {
  version: 1,
  personId: workGraphFixtureIds.owner,
  day: '2026-09-19',
  timezone: 'America/New_York',
  target: { kind: 'node', id: workGraphFixtureIds.terminalNode },
  eventId: validCloudEventFixture.eventId,
  observedAt: '2026-09-19T14:05:00.000Z',
};

export const emptySnapshotFixture: WorkGraphSnapshot = {
  schemaVersion: 1,
  scope: {
    personId: workGraphFixtureIds.owner,
    day: '2026-09-19',
    timezone: 'America/New_York',
    policyRevision: 'policy-fixture-1',
  },
  revision: 1,
  watermark: 1,
  cursor: 'opaque.fixture.cursor',
  nodes: [],
  edges: [],
  sources: [],
  partial: false,
};

/** Expected outcomes for T01's runtime validators. */
export const validationOutcomeFixtures = [
  { name: 'valid cloud event', value: validCloudEventFixture, validatesAs: 'event', valid: true },
  { name: 'valid active grant', value: activeSharingGrantFixture, validatesAs: 'grant', valid: true },
  { name: 'valid node reference', value: nodeReferenceFixture, validatesAs: 'reference', valid: true },
  { name: 'invalid version', value: { ...nodeReferenceFixture, version: 2 }, validatesAs: 'reference', valid: false },
  { name: 'mutually exclusive target', value: { ...nodeReferenceFixture, target: { kind: 'node', id: workGraphFixtureIds.terminalNode, edgeId: workGraphFixtureIds.edge } }, validatesAs: 'reference', valid: false },
  { name: 'untrusted producer organization', value: { ...validCloudEventFixture, producer: { ...validCloudEventFixture.producer, organizationId: 'org_other' } }, validatesAs: 'event', valid: false },
] as const;
