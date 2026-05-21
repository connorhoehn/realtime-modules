/**
 * FeatureManifest contract tests.
 *
 * Pins the shape of the exported manifests so they stay in sync with:
 *   - the FeatureManifest interface
 *   - the actual channel patterns the services subscribe to / publish on
 *   - the actual env vars the services read at runtime
 *
 * If you add a new env-var or channel pattern in a service, update the
 * manifest AND this test in the same commit.
 */

import { crdtManifest } from '../src/server/manifest';
import { agentStreamingManifest } from '../src/agent-streaming/manifest';
import type { FeatureManifest } from '../src/feature-manifest/types';

// Re-export from the subpath barrels to verify the wiring is hooked up.
import { crdtManifest as crdtManifestFromBarrel } from '../src/server';
import {
    agentStreamingManifest as agentStreamingManifestFromBarrel,
    AgentStreamingManifest,
} from '../src/agent-streaming';

// --- Shared shape assertions ------------------------------------------------

function assertManifestShape(m: FeatureManifest): void {
    expect(typeof m.name).toBe('string');
    expect(m.name.length).toBeGreaterThan(0);
    expect(typeof m.version).toBe('string');
    expect(m.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(Array.isArray(m.channels)).toBe(true);
    expect(Array.isArray(m.dependencies)).toBe(true);

    if (m.envVars) {
        for (const [key, spec] of Object.entries(m.envVars)) {
            expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
            expect(typeof spec.description).toBe('string');
            expect(spec.description.length).toBeGreaterThan(0);
            if (spec.required !== undefined) {
                expect(typeof spec.required).toBe('boolean');
            }
            if (spec.default !== undefined) {
                expect(typeof spec.default).toBe('string');
            }
        }
    }
}

describe('crdtManifest', () => {
    it('matches the FeatureManifest contract', () => {
        assertManifestShape(crdtManifest);
    });

    it('is re-exported from @connorhoehn/realtime-modules/server', () => {
        expect(crdtManifestFromBarrel).toBe(crdtManifest);
    });

    it('identifies itself as the document-sharing feature', () => {
        expect(crdtManifest.name).toBe('document-sharing');
    });

    it('declares the WS channel patterns the CRDT service actually uses', () => {
        // CRDTService subscribes/publishes on per-document channels under the
        // `doc:` prefix (see handleCreateDocument / deleteDocument /
        // deduplicateSections, plus DocumentPresenceService's `doc:` guard).
        // The orchestrator also broadcasts `crdt:*`-shaped wire messages on
        // those channels and publishes doc.created onto activity:broadcast.
        expect(crdtManifest.channels).toEqual(
            expect.arrayContaining(['doc:*', 'activity:broadcast']),
        );
        // crdt:* covers logical CRDT-action channels passed to handleSubscribe.
        expect(crdtManifest.channels).toContain('crdt:*');
    });

    it('documents every env var the server subpath reads at runtime', () => {
        // Mirror of `grep -n process.env src/server`. If you add a new read,
        // add it here AND to the manifest in the same commit.
        const envVarsFromSource = new Set([
            'SNAPSHOT_DEBOUNCE_MS',
            'SNAPSHOT_INTERVAL_MS',
            'IDLE_EVICTION_MS',
            'DDB_TABLE_PREFIX',
            'DYNAMODB_CRDT_TABLE',
            'DYNAMODB_DOCUMENTS_TABLE',
            'EVENT_BUS_NAME',
        ]);
        const documented = new Set(Object.keys(crdtManifest.envVars ?? {}));
        for (const key of envVarsFromSource) {
            expect(documented.has(key)).toBe(true);
        }
    });

    it('points consumers at the realtime-modules client subpath', () => {
        expect(crdtManifest.install?.frontendImport).toBe(
            '@connorhoehn/realtime-modules/client',
        );
        // realtime-modules does not ship backend routes for CRDT — the
        // consumer wires CRDTService into its own WS message router.
        expect(crdtManifest.install?.backendRoutes).toBeUndefined();
    });
});

describe('agentStreamingManifest', () => {
    it('matches the FeatureManifest contract', () => {
        assertManifestShape(agentStreamingManifest);
    });

    it('is re-exported from @connorhoehn/realtime-modules/agent-streaming', () => {
        expect(agentStreamingManifestFromBarrel).toBe(agentStreamingManifest);
    });

    it('keeps the legacy AgentStreamingManifest alias pointing at the same object', () => {
        // Pre-extraction callers imported `AgentStreamingManifest` (capitalised);
        // the alias keeps that import path working.
        expect(AgentStreamingManifest).toBe(agentStreamingManifest);
    });

    it('identifies itself as the agent-streaming feature', () => {
        expect(agentStreamingManifest.name).toBe('agent-streaming');
    });

    it('declares zero WS channels (HTTP POST + SSE only)', () => {
        expect(agentStreamingManifest.channels).toEqual([]);
    });

    it('documents the SSE heartbeat env var', () => {
        const heartbeat = agentStreamingManifest.envVars?.AGENT_STREAM_HEARTBEAT_MS;
        expect(heartbeat).toBeDefined();
        expect(heartbeat?.default).toBe('25000');
    });

    it('points consumers at the middleware factory + UI components package', () => {
        expect(agentStreamingManifest.install?.backendRoutes).toContain(
            'agent-streaming',
        );
        expect(agentStreamingManifest.install?.frontendImport).toBe(
            '@connorhoehnslalom/ui-components/agents',
        );
    });
});
