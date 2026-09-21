"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectWorkEvent = projectWorkEvent;
const opaqueId_1 = require("./opaqueId");
function nodeId(state, kind, ref) {
    return (0, opaqueId_1.opaqueWorkId)('node', state.organizationId, state.actorId, kind, ref.source, ref.resourceId);
}
function numericSequence(value) {
    return value !== undefined && /^\d+$/.test(value) ? BigInt(value) : undefined;
}
function isNewer(event, entity) {
    const incomingSequence = numericSequence(event.sourceSequence);
    const existingSequence = numericSequence(entity.sourceSequence);
    // Compare like units only: an event without a source sequence must not have
    // its epoch milliseconds compared with another event's sequence counter.
    const incoming = incomingSequence !== undefined && existingSequence !== undefined
        ? incomingSequence : Date.parse(event.occurredAt);
    const existing = incomingSequence !== undefined && existingSequence !== undefined
        ? existingSequence : Date.parse(entity.updatedAt);
    return incoming > existing || (incoming === existing && event.eventId > entity.sourceEventId);
}
function statusFor(event) {
    switch (event.payload.kind) {
        case 'cloud-compute':
            return { created: 'idle', started: 'running', waiting: 'waiting', completed: 'completed', stopped: 'stopped', failed: 'error', deleted: 'stopped' }[event.payload.lifecycle];
        case 'local-compute':
            return { 'session-started': 'running', 'session-ended': 'stopped', 'job-started': 'running', 'job-finished': 'completed', heartbeat: 'idle', disconnected: 'stale' }[event.payload.lifecycle];
        case 'document':
            return event.payload.lifecycle === 'deleted' ? 'stopped' : 'completed';
        case 'pipeline':
            return { started: 'running', waiting: 'waiting', completed: 'completed', failed: 'error', cancelled: 'stopped' }[event.payload.lifecycle];
        case 'conversation':
            return event.payload.lifecycle === 'membership-removed' ? 'stopped' : 'completed';
        case 'meeting':
            if (event.payload.lifecycle.endsWith('-failed'))
                return 'error';
            if (event.payload.lifecycle.endsWith('-deleted') || event.payload.lifecycle === 'attendance-ended')
                return 'stopped';
            if (event.payload.lifecycle.endsWith('-started'))
                return 'running';
            return 'completed';
    }
}
function sourceRef(event, resourceId) {
    return { source: event.source, resourceId };
}
function inputsFor(event) {
    const status = statusFor(event);
    const label = event.payload.safeLabel?.trim();
    const safe = (fallback) => label || fallback;
    const generic = label ? undefined : true;
    switch (event.payload.kind) {
        case 'cloud-compute': {
            const terminal = { kind: 'terminal', resourceId: event.payload.boxId, title: safe('Cloud terminal'), generic, status };
            if (event.payload.lifecycle === 'deleted')
                return { nodes: [{ ...terminal, deleting: true }], edges: [] };
            const nodes = [terminal];
            const edges = [];
            if (event.payload.projectId) {
                const projectLabel = event.payload.projectLabel?.trim();
                const project = { kind: 'project', resourceId: event.payload.projectId, title: projectLabel || 'Project', ...(projectLabel ? {} : { generic: true }), status: 'idle' };
                nodes.push(project);
                edges.push({ from: terminal, to: project, relation: 'works-on' });
            }
            if (event.payload.jobId) {
                const run = { kind: 'run', resourceId: event.payload.jobId, title: safe('Agent run'), generic, status };
                nodes.push(run);
                edges.push({ from: run, to: terminal, relation: 'runs-in' });
                if (event.payload.agentId) {
                    const agent = { kind: 'agent', resourceId: event.payload.agentId, title: 'Agent', generic: true, status };
                    nodes.push(agent);
                    edges.push({ from: agent, to: run, relation: 'operates-on' });
                }
            }
            return { nodes, edges };
        }
        case 'local-compute': {
            const terminal = { kind: 'terminal', resourceId: event.payload.machineId, title: safe('Local terminal'), generic, status };
            const nodes = [terminal];
            const edges = [];
            if (event.payload.projectId) {
                const project = { kind: 'project', resourceId: event.payload.projectId, title: 'Project', generic: true, status: 'idle' };
                nodes.push(project);
                edges.push({ from: terminal, to: project, relation: 'works-on' });
            }
            if (event.payload.jobId) {
                const run = { kind: 'run', resourceId: event.payload.jobId, title: safe('Agent run'), generic, status };
                nodes.push(run);
                edges.push({ from: run, to: terminal, relation: 'runs-in' });
            }
            return { nodes, edges };
        }
        case 'document': {
            const document = { kind: 'document', resourceId: event.payload.documentId, title: safe('Document'), generic, status };
            if (event.payload.lifecycle === 'deleted')
                return { nodes: [{ ...document, deleting: true }], edges: [] };
            // A revision reads as the document it changed, so the card is not a row
            // of identical "Document change" entries once several revisions exist.
            const change = {
                kind: 'change',
                resourceId: `${event.payload.documentId}:${event.payload.revisionId}`,
                title: label ? `${label} · revision`.slice(0, 160) : 'Document change',
                ...(label ? {} : { generic: true }),
                status,
            };
            const producedBy = event.payload.producedByRunId;
            return {
                nodes: [document, change],
                edges: [{ from: change, to: document, relation: 'edited' }],
                // The save record itself attributes the revision to a run. Only a run
                // node already projected by its own source can be named here.
                ...(producedBy
                    ? {
                        crossEdges: [{
                                from: { existing: { source: 'pipeline', resourceId: producedBy }, kinds: ['run'] },
                                to: document,
                                relation: 'produced',
                            }],
                    }
                    : {}),
            };
        }
        case 'pipeline': {
            const run = { kind: 'run', resourceId: event.payload.runId, title: safe('Pipeline run'), generic, status };
            const declared = event.payload.inputs ?? [];
            return {
                nodes: [run],
                edges: [],
                // `derived-from` points at the evidence the run consumed. Direction is
                // run -> input, matching the transcript -> meeting convention above.
                crossEdges: declared.map((ref) => ({ from: run, to: { existing: ref }, relation: 'derived-from' })),
            };
        }
        case 'conversation': {
            const conversation = { kind: 'conversation', resourceId: event.payload.conversationId, title: safe(event.payload.conversationKind === 'dm' ? 'Direct conversation' : 'Conversation'), generic, status, deleting: event.payload.lifecycle === 'membership-removed' };
            const related = event.payload.explicitRelatedResource;
            return {
                nodes: [conversation],
                edges: [],
                ...(related && event.payload.lifecycle === 'contributed'
                    ? { crossEdges: [{ from: conversation, to: { existing: related }, relation: 'discussed' }] }
                    : {}),
            };
        }
        case 'meeting': {
            const meeting = { kind: 'meeting', resourceId: event.payload.meetingId, title: safe('Meeting'), generic, status };
            // Recording lifecycle does not delete the meeting itself. Recordings do
            // not have a graph node; a transcript deletion targets only its node.
            if (event.payload.lifecycle === 'recording-deleted')
                return { nodes: [], edges: [] };
            if (event.payload.lifecycle === 'transcript-deleted') {
                return {
                    nodes: event.payload.transcriptId
                        ? [{ kind: 'transcript', resourceId: event.payload.transcriptId, title: 'Transcript', generic: true, status, deleting: true }]
                        : [],
                    edges: [],
                };
            }
            const nodes = [meeting];
            const edges = [];
            if (event.payload.transcriptId) {
                const transcript = { kind: 'transcript', resourceId: event.payload.transcriptId, title: 'Transcript', generic: true, status };
                nodes.push(transcript);
                edges.push({ from: transcript, to: meeting, relation: 'derived-from' });
            }
            return { nodes, edges };
        }
    }
}
function upsertNode(state, event, input) {
    const ref = sourceRef(event, input.resourceId);
    const id = nodeId(state, input.kind, ref);
    const existing = state.nodes[id];
    if (existing && !isNewer(event, existing))
        return existing;
    return {
        id,
        organizationId: event.actor.organizationId,
        actorId: event.actor.actorId,
        kind: input.kind,
        sourceRef: ref,
        policyRef: `${event.source}:${input.kind}`,
        // A placeholder never overwrites a name a source already supplied. The
        // platform's own republished lifecycle events omit `safeLabel`, and that
        // used to reset a real title back to "Pipeline run".
        title: input.generic && existing && !existing.deletedAt ? existing.title : input.title,
        status: input.status ?? statusFor(event),
        startedAt: existing?.startedAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
        ...(input.deleting ? { endedAt: event.occurredAt, deletedAt: event.occurredAt } : {}),
        sourceEventId: event.eventId,
        ...(event.sourceSequence ? { sourceSequence: event.sourceSequence } : {}),
        revision: (existing?.revision ?? 0) + 1,
    };
}
/**
 * Resolves a cross-source endpoint to an existing projected node. Lookup is by
 * the resource the source named, never by actor or time proximity, and a
 * deleted or absent counterpart simply drops the relationship.
 */
function resolveEndpoint(state, event, endpoint) {
    if (!('existing' in endpoint))
        return nodeId(state, endpoint.kind, sourceRef(event, endpoint.resourceId));
    const { source, resourceId } = endpoint.existing;
    const matches = Object.values(state.nodes).filter((node) => !node.deletedAt
        && node.sourceRef.source === source
        && node.sourceRef.resourceId === resourceId
        && (!endpoint.kinds || endpoint.kinds.includes(node.kind)));
    // A resource that resolves to more than one node is ambiguous provenance.
    return matches.length === 1 ? matches[0].id : undefined;
}
/** Pure, idempotent projection over an already validated source event. */
function projectWorkEvent(current, event) {
    if (current.organizationId !== event.actor.organizationId || current.actorId !== event.actor.actorId) {
        throw new RangeError('event actor is outside the projection scope');
    }
    // IDs are unique within a source, matching the durable repository's event
    // marker. Different producers may legitimately use the same event ID.
    const eventKey = `${event.source}:${event.eventId}`;
    if (current.appliedEventIds.includes(eventKey))
        return current;
    const previousSequence = numericSequence(current.sourceCheckpoints[event.source]);
    const incomingSequence = numericSequence(event.sourceSequence);
    const advanceCheckpoint = event.sourceSequence !== undefined
        && !(previousSequence !== undefined && incomingSequence !== undefined && incomingSequence < previousSequence);
    const next = {
        ...current,
        revision: current.revision + 1,
        nodes: { ...current.nodes },
        edges: { ...current.edges },
        sourceCheckpoints: { ...current.sourceCheckpoints, ...(advanceCheckpoint ? { [event.source]: event.sourceSequence } : {}) },
        appliedEventIds: [...current.appliedEventIds, eventKey],
    };
    const inputs = inputsFor(event);
    const deletedNodeIds = new Set();
    for (const input of inputs.nodes) {
        const node = upsertNode(next, event, input);
        next.nodes[node.id] = node;
        if (node.deletedAt && node.sourceEventId === event.eventId)
            deletedNodeIds.add(node.id);
    }
    const link = (fromId, toId, relation) => {
        if (!fromId || !toId || fromId === toId)
            return;
        if (!next.nodes[fromId] || !next.nodes[toId] || next.nodes[fromId].deletedAt || next.nodes[toId].deletedAt)
            return;
        const id = (0, opaqueId_1.opaqueWorkId)('edge', fromId, toId, relation);
        const existing = next.edges[id];
        if (existing && !isNewer(event, existing))
            return;
        const edge = {
            id,
            organizationId: event.actor.organizationId,
            actorId: event.actor.actorId,
            fromId,
            toId,
            relation,
            policyRef: `${event.source}:relation:${relation}`,
            status: statusFor(event),
            startedAt: existing?.startedAt ?? event.occurredAt,
            updatedAt: event.occurredAt,
            sourceEventId: event.eventId,
            ...(event.sourceSequence ? { sourceSequence: event.sourceSequence } : {}),
            provenance: 'source-event',
            revision: (existing?.revision ?? 0) + 1,
        };
        next.edges[id] = edge;
    };
    for (const input of inputs.edges) {
        link(nodeId(next, input.from.kind, sourceRef(event, input.from.resourceId)), nodeId(next, input.to.kind, sourceRef(event, input.to.resourceId)), input.relation);
    }
    for (const input of inputs.crossEdges ?? []) {
        link(resolveEndpoint(next, event, input.from), resolveEndpoint(next, event, input.to), input.relation);
    }
    // Delete all incident relationships, including ones absent from the delete
    // payload. Keep the other endpoints and their unrelated relationships.
    for (const edge of Object.values(next.edges)) {
        if ((!deletedNodeIds.has(edge.fromId) && !deletedNodeIds.has(edge.toId)) || !isNewer(event, edge))
            continue;
        next.edges[edge.id] = {
            ...edge, status: 'stopped', updatedAt: event.occurredAt,
            endedAt: event.occurredAt, deletedAt: event.occurredAt,
            sourceEventId: event.eventId, sourceSequence: event.sourceSequence,
            revision: edge.revision + 1,
        };
    }
    return next;
}
//# sourceMappingURL=projectEvent.js.map