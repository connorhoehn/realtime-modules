/** Error code of a WHIP refused because the participant's publishing is revoked. */
export declare const LVS_PUBLISH_REVOKED = "LVS_PUBLISH_REVOKED";
/** The token request made before the first publish after a grant. */
export interface LVSAuthTokenRequest {
    /** Return a token minted now, not a cached one. */
    forceRefresh?: boolean;
    /** Why: `'publish-granted'` after a grant. */
    reason?: string;
}
/** Resolves the participant token. Older resolvers ignore the request. */
export type LVSAuthTokenResolver = (request?: LVSAuthTokenRequest) => string | Promise<string>;
/** The local participant's publish permission. */
export interface PublishPermissionState {
    /** May publish now: false while revoked, and for a subscriber token until a grant. */
    canPublish: boolean;
    /** LVS revoked publishing; the participant stays in the call as a viewer. */
    publishRevoked: boolean;
    /** The host's reason for the revocation, or null. */
    reason: string | null;
}
export declare const EMPTY_PUBLISH_STATE: PublishPermissionState;
export type PublishPermissionAction = 
/** A new session: what its token allows. */
{
    type: 'reset';
    canPublish?: boolean;
} | {
    type: 'revoked';
    reason?: string | null;
} | {
    type: 'granted';
};
/** Returns the same object when nothing changes. */
export declare function reducePublishState(state: PublishPermissionState, action: PublishPermissionAction): PublishPermissionState;
/** A publish LVS refused because publishing is revoked (final until a grant). */
export declare function isPublishRevokedError(err: unknown): boolean;
/** A parsed publish-control stage frame. */
export interface PublishControlFrame {
    revoked: boolean;
    participantId: string;
    userId: string | null;
    reason: string | null;
}
/** `participant.publish-revoked` / `participant.publish-granted`, or null for any other frame. */
export declare function parsePublishControlFrame(msg: unknown): PublishControlFrame | null;
/** The stage socket's final close codes. */
export declare const STAGE_CLOSE_FORBIDDEN = 4403;
export declare const STAGE_CLOSE_KICKED = 4410;
/** How LVS ended the stage for this participant. Reconnecting would be refused. */
export interface HangoutTermination {
    outcome: 'forbidden' | 'kicked';
    code: number;
    /** The close reason LVS sent, or null. */
    reason: string | null;
}
/** A final stage close, or null when the close may be reconnected. */
export declare function stageTermination(code: unknown, reason?: unknown): HangoutTermination | null;
/** What to tell the person whose stage ended. */
export declare function terminationMessage(t: HangoutTermination): string;
/** Token attributes: string values only (anything else is dropped). Null when none. */
export declare function tokenAttributes(value: unknown): Record<string, string> | null;
//# sourceMappingURL=publishPermission.d.ts.map