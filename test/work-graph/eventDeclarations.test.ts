import { WORK_GRAPH_LIMITS } from '../../src/work-graph/contracts';
import { isWithinWorkGraphEventLimit, workGraphEventDeclarations, workGraphHeartbeatDeclaration, workGraphLifecycleDeclarations, workGraphProjectionChangedDeclaration, workGraphProducersFor } from '../../src/work-graph/eventDeclarations';

describe('work graph event declarations', () => {
  test('declares one durable lifecycle producer per source and a distinct transient heartbeat', () => {
    expect(workGraphLifecycleDeclarations).toHaveLength(6);
    expect(workGraphLifecycleDeclarations.every((entry) => entry.transport === 'durable' && entry.queue === 'work-graph-projection-v1')).toBe(true);
    expect(workGraphHeartbeatDeclaration).toMatchObject({ transport: 'signal', producer: 'aws-agentcore' });
    expect(workGraphHeartbeatDeclaration).not.toHaveProperty('queue');
  });

  test('pins producer identities and backward-compatible schema versioning', () => {
    expect(workGraphEventDeclarations.map((entry) => [entry.name, entry.producer])).toEqual([
      ['work-graph.cloud-compute.lifecycle.v1', 'aws-agentcore'],
      ['work-graph.local-compute.lifecycle.v1', 'aws-agentcore'],
      ['work-graph.document.lifecycle.v1', 'websocket-gateway'],
      ['work-graph.pipeline.lifecycle.v1', 'platform-api'],
      ['work-graph.conversation.lifecycle.v1', 'websocket-gateway'],
      ['work-graph.meeting.lifecycle.v1', 'platform-api'],
      ['work-graph.local-compute.heartbeat.v1', 'aws-agentcore'],
      ['work-graph.projection.changed.v1', 'platform-api'],
    ]);
    expect(workGraphEventDeclarations.every((entry) => entry.version === 1 && entry.compatibilityMode === 'backward')).toBe(true);
  });

  test('declares durable private projection notifications for authorized gateway replay', () => {
    expect(workGraphProjectionChangedDeclaration).toMatchObject({
      name: 'work-graph.projection.changed.v1',
      producer: 'platform-api',
      transport: 'durable',
      queue: 'work-graph-projection-changed-v1',
      dlqAfterAttempts: 5,
    });
  });

  test('schemas are allowlists and omit private raw fields', () => {
    const serialized = JSON.stringify(workGraphEventDeclarations);
    expect(serialized).not.toMatch(/prompt|output|credentialSecret|transcriptText|joinToken|worktreePath|messageContent/);
    for (const entry of workGraphEventDeclarations) {
      expect(entry.schema).toMatchObject({ additionalProperties: false });
      expect(entry.tags).toContain(`max-bytes:${WORK_GRAPH_LIMITS.sourceEventBytes}`);
    }
  });

  test('enforces the byte bound before catalog publication', () => {
    expect(isWithinWorkGraphEventLimit({ eventId: 'small' })).toBe(true);
    expect(isWithinWorkGraphEventLimit({ value: 'x'.repeat(WORK_GRAPH_LIMITS.sourceEventBytes) })).toBe(false);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(isWithinWorkGraphEventLimit(circular)).toBe(false);
  });
});

describe('the pipeline lifecycle schema accepts everything its own contract emits', () => {
  const pipeline = workGraphLifecycleDeclarations
    .find((entry) => entry.name === 'work-graph.pipeline.lifecycle.v1') as { schema: Record<string, unknown> };
  const payloadProperties = ((pipeline.schema.properties as Record<string, { properties?: Record<string, unknown> }>)
    .payload?.properties ?? {}) as Record<string, unknown>;

  test('declares the relationship fields the reducer reads', () => {
    // A field the reducer honours but the schema rejects is invisible: the
    // event is refused at publish time, and the projection simply never sees
    // the run. `inputs` did exactly that until it was declared here.
    for (const field of ['inputs', 'produces', 'workspace', 'artifactIds', 'safeLabel']) {
      expect(payloadProperties).toHaveProperty(field);
    }
  });

  test('a relationship names a source and a resource, and nothing free-form', () => {
    expect(payloadProperties.inputs).toMatchObject({
      type: 'array',
      items: { additionalProperties: false, required: ['source', 'resourceId'] },
    });
    expect(payloadProperties.workspace).toMatchObject({
      type: 'object', additionalProperties: false, required: ['resourceId'],
    });
  });

  test('every source a relationship may name is a real work source', () => {
    const sources = ((payloadProperties.inputs as { items: { properties: { source: { enum: string[] } } } })
      .items.properties.source.enum);
    expect(sources.sort()).toEqual(
      ['cloud-compute', 'conversation', 'document', 'local-compute', 'meeting', 'pipeline'],
    );
  });
});

describe('a document has two legitimate writers', () => {
  const documentDeclaration = workGraphLifecycleDeclarations
    .find((entry) => entry.name === 'work-graph.document.lifecycle.v1') as { producer: string; producers: readonly string[]; schema: Record<string, unknown> };

  it('names the gateway first and admits the platform beside it', () => {
    // A generated presentation is a document whose row platform-api writes;
    // the gateway never sees one.
    expect(documentDeclaration.producer).toBe('websocket-gateway');
    expect([...documentDeclaration.producers].sort()).toEqual(['platform-api', 'websocket-gateway']);
    expect(workGraphProducersFor('document')).toContain('platform-api');
  });

  it('lets the schema accept either service, and no third one', () => {
    const schema = documentDeclaration.schema as unknown as {
      properties: { producer: { properties: { serviceId: { enum: string[] } } } };
    };
    const producer = schema.properties.producer.properties.serviceId.enum;
    expect([...producer].sort()).toEqual(['platform-api', 'websocket-gateway']);
  });

  it('leaves every other source with exactly one writer', () => {
    for (const source of ['cloud-compute', 'local-compute', 'pipeline', 'conversation', 'meeting'] as const) {
      expect(workGraphProducersFor(source)).toHaveLength(1);
    }
  });
});
