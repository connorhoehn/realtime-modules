"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validationOutcomeFixtures = exports.emptySnapshotFixture = exports.nodeReferenceFixture = exports.deniedDisclosureFixture = exports.allowedDisclosureFixture = exports.outsiderScopeFixture = exports.viewerScopeFixture = exports.activeSharingGrantFixture = exports.validCloudEventFixture = exports.workGraphFixtureIds = void 0;
exports.workGraphFixtureIds = {
    organization: 'org_active_now_fixture',
    owner: 'person_owner_fixture',
    viewer: 'person_viewer_fixture',
    outsider: 'person_outsider_fixture',
    projectNode: 'wg_node_project_fixture',
    terminalNode: 'wg_node_terminal_fixture',
    edge: 'wg_edge_runs_in_fixture',
    grant: 'wg_grant_fixture',
};
exports.validCloudEventFixture = {
    schemaVersion: 1,
    eventId: 'event_cloud_fixture_001',
    idempotencyKey: 'cloud:job_fixture:1:started',
    source: 'cloud-compute',
    sourceSequence: '1',
    occurredAt: '2026-09-19T14:00:00.000Z',
    receivedAt: '2026-09-19T14:00:01.000Z',
    actor: {
        actorId: exports.workGraphFixtureIds.owner,
        organizationId: exports.workGraphFixtureIds.organization,
        sourceSubject: 'orgiq-subject-owner-fixture',
    },
    producer: {
        serviceId: 'orgiq-middleware',
        organizationId: exports.workGraphFixtureIds.organization,
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
exports.activeSharingGrantFixture = {
    schemaVersion: 1,
    id: exports.workGraphFixtureIds.grant,
    organizationId: exports.workGraphFixtureIds.organization,
    ownerId: exports.workGraphFixtureIds.owner,
    audience: { kind: 'people', personIds: [exports.workGraphFixtureIds.viewer] },
    selection: {
        nodeIds: [exports.workGraphFixtureIds.projectNode, exports.workGraphFixtureIds.terminalNode],
        edgeIds: [exports.workGraphFixtureIds.edge],
        disclosure: 'summary',
    },
    state: 'active',
    createdAt: '2026-09-19T13:55:00.000Z',
    updatedAt: '2026-09-19T13:55:00.000Z',
    expiresAt: '2026-09-19T21:55:00.000Z',
    revision: 1,
};
exports.viewerScopeFixture = {
    organizationId: exports.workGraphFixtureIds.organization,
    viewerId: exports.workGraphFixtureIds.viewer,
    personId: exports.workGraphFixtureIds.owner,
    day: '2026-09-19',
    timezone: 'America/New_York',
    policyRevision: 'policy-fixture-1',
};
exports.outsiderScopeFixture = {
    ...exports.viewerScopeFixture,
    viewerId: exports.workGraphFixtureIds.outsider,
};
exports.allowedDisclosureFixture = [
    {
        targetId: exports.workGraphFixtureIds.projectNode,
        decision: 'allow',
        maximumDisclosure: 'summary',
        capabilities: ['message'],
        policyRevision: 'policy-fixture-1',
    },
    {
        targetId: exports.workGraphFixtureIds.terminalNode,
        decision: 'allow',
        maximumDisclosure: 'summary',
        capabilities: ['observe-terminal'],
        policyRevision: 'policy-fixture-1',
    },
    {
        targetId: exports.workGraphFixtureIds.edge,
        decision: 'allow',
        maximumDisclosure: 'summary',
        capabilities: ['message'],
        policyRevision: 'policy-fixture-1',
    },
];
exports.deniedDisclosureFixture = exports.allowedDisclosureFixture.map((item) => ({
    targetId: item.targetId,
    decision: 'deny',
    policyRevision: 'policy-fixture-1',
}));
exports.nodeReferenceFixture = {
    version: 1,
    personId: exports.workGraphFixtureIds.owner,
    day: '2026-09-19',
    timezone: 'America/New_York',
    target: { kind: 'node', id: exports.workGraphFixtureIds.terminalNode },
    eventId: exports.validCloudEventFixture.eventId,
    observedAt: '2026-09-19T14:05:00.000Z',
};
exports.emptySnapshotFixture = {
    schemaVersion: 1,
    scope: {
        personId: exports.workGraphFixtureIds.owner,
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
exports.validationOutcomeFixtures = [
    { name: 'valid cloud event', value: exports.validCloudEventFixture, validatesAs: 'event', valid: true },
    { name: 'valid active grant', value: exports.activeSharingGrantFixture, validatesAs: 'grant', valid: true },
    { name: 'valid node reference', value: exports.nodeReferenceFixture, validatesAs: 'reference', valid: true },
    { name: 'invalid version', value: { ...exports.nodeReferenceFixture, version: 2 }, validatesAs: 'reference', valid: false },
    { name: 'mutually exclusive target', value: { ...exports.nodeReferenceFixture, target: { kind: 'node', id: exports.workGraphFixtureIds.terminalNode, edgeId: exports.workGraphFixtureIds.edge } }, validatesAs: 'reference', valid: false },
    { name: 'untrusted producer organization', value: { ...exports.validCloudEventFixture, producer: { ...exports.validCloudEventFixture.producer, organizationId: 'org_other' } }, validatesAs: 'event', valid: false },
];
//# sourceMappingURL=fixtures.js.map