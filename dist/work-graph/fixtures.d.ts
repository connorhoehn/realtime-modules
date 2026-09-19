import type { AuthenticatedWorkEvent, DisclosureDecision, WorkGraphQueryScope, WorkGraphSnapshot, WorkReference, WorkSharingGrant } from './contracts';
export declare const workGraphFixtureIds: {
    readonly organization: "org_active_now_fixture";
    readonly owner: "person_owner_fixture";
    readonly viewer: "person_viewer_fixture";
    readonly outsider: "person_outsider_fixture";
    readonly projectNode: "wg_node_project_fixture";
    readonly terminalNode: "wg_node_terminal_fixture";
    readonly edge: "wg_edge_runs_in_fixture";
    readonly grant: "wg_grant_fixture";
};
export declare const validCloudEventFixture: AuthenticatedWorkEvent;
export declare const activeSharingGrantFixture: WorkSharingGrant;
export declare const viewerScopeFixture: WorkGraphQueryScope;
export declare const outsiderScopeFixture: WorkGraphQueryScope;
export declare const allowedDisclosureFixture: DisclosureDecision[];
export declare const deniedDisclosureFixture: DisclosureDecision[];
export declare const nodeReferenceFixture: WorkReference;
export declare const emptySnapshotFixture: WorkGraphSnapshot;
/** Expected outcomes for T01's runtime validators. */
export declare const validationOutcomeFixtures: readonly [{
    readonly name: "valid cloud event";
    readonly value: AuthenticatedWorkEvent;
    readonly validatesAs: "event";
    readonly valid: true;
}, {
    readonly name: "valid active grant";
    readonly value: WorkSharingGrant;
    readonly validatesAs: "grant";
    readonly valid: true;
}, {
    readonly name: "valid node reference";
    readonly value: WorkReference;
    readonly validatesAs: "reference";
    readonly valid: true;
}, {
    readonly name: "invalid version";
    readonly value: {
        readonly version: 2;
        readonly personId: string;
        readonly day: import("./contracts").CalendarDate;
        readonly timezone: import("./contracts").IanaTimezone;
        readonly sessionId?: import("./contracts").OpaqueWorkId;
        readonly target: import("./contracts").WorkReferenceTarget;
        readonly eventId?: string;
        readonly observedAt?: import("./contracts").IsoTimestamp;
    };
    readonly validatesAs: "reference";
    readonly valid: false;
}, {
    readonly name: "mutually exclusive target";
    readonly value: {
        readonly target: {
            readonly kind: "node";
            readonly id: "wg_node_terminal_fixture";
            readonly edgeId: "wg_edge_runs_in_fixture";
        };
        readonly version: import("./contracts").WorkGraphSchemaVersion;
        readonly personId: string;
        readonly day: import("./contracts").CalendarDate;
        readonly timezone: import("./contracts").IanaTimezone;
        readonly sessionId?: import("./contracts").OpaqueWorkId;
        readonly eventId?: string;
        readonly observedAt?: import("./contracts").IsoTimestamp;
    };
    readonly validatesAs: "reference";
    readonly valid: false;
}, {
    readonly name: "untrusted producer organization";
    readonly value: {
        readonly producer: {
            readonly organizationId: "org_other";
            readonly serviceId: string;
            readonly credentialId: string;
        };
        readonly schemaVersion: import("./contracts").WorkGraphSchemaVersion;
        readonly eventId: string;
        readonly idempotencyKey: string;
        readonly source: import("./contracts").WorkSourceKind;
        readonly sourceSequence?: string;
        readonly occurredAt: import("./contracts").IsoTimestamp;
        readonly receivedAt: import("./contracts").IsoTimestamp;
        readonly actor: import("./contracts").AuthenticatedWorkActor;
        readonly resource: import("./contracts").WorkSourceRef;
        readonly payload: import("./contracts").WorkSourcePayload;
    };
    readonly validatesAs: "event";
    readonly valid: false;
}];
//# sourceMappingURL=fixtures.d.ts.map