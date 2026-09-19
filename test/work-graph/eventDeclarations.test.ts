import { WORK_GRAPH_LIMITS } from '../../src/work-graph/contracts';
import { isWithinWorkGraphEventLimit, workGraphEventDeclarations, workGraphHeartbeatDeclaration, workGraphLifecycleDeclarations, workGraphProjectionChangedDeclaration } from '../../src/work-graph/eventDeclarations';

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
