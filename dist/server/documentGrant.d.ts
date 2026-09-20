/** Narrow user grants for document transports. Service credentials are not user identity. */
import { type KeyObject } from 'node:crypto';
export type DocumentOperation = 'read' | 'comment' | 'edit' | 'manage' | 'seed';
export type DocumentGrantOperation = DocumentOperation;
export interface DocumentGrantClaims {
    iss: string;
    aud: string;
    sub: string;
    tenantId: string;
    documentId: string;
    operations: DocumentOperation[];
    sessionId: string;
    sessionEpoch: number;
    iat: number;
    exp: number;
    jti: string;
}
export interface DocumentGrantVerifierOptions {
    issuer: string;
    audience?: string;
    resolvePublicKey: (kid: string) => string | KeyObject | Promise<string | KeyObject>;
    /** Authoritative lookup on every request/frame. Missing or unavailable sessions fail closed. */
    getSessionEpoch: (claims: DocumentGrantClaims) => number | null | Promise<number | null>;
    now?: () => number;
}
export declare function createDocumentGrant(claims: Omit<DocumentGrantClaims, 'aud' | 'iat' | 'exp' | 'jti'> & Partial<Pick<DocumentGrantClaims, 'aud' | 'iat' | 'exp' | 'jti'>>, options: {
    privateKey: string | KeyObject;
    keyId: string;
    now?: () => number;
}): string;
export declare function verifyDocumentGrant(token: string, options: DocumentGrantVerifierOptions): Promise<DocumentGrantClaims>;
export declare function documentGrantAllows(claims: DocumentGrantClaims, scope: {
    tenantId: string;
    documentId: string;
    operation: DocumentOperation;
}): boolean;
export declare function createDocumentGrantVerifierFromEnv(env: Record<string, string | undefined>, options?: Pick<DocumentGrantVerifierOptions, 'getSessionEpoch' | 'now'>): ((token: string) => Promise<DocumentGrantClaims>) | null;
/** Bounded server-to-server epoch lookup. Never follows redirects carrying a service credential. */
export declare function createDocumentSessionEpochResolver(options: {
    url: string;
    secret: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}): (claims: Pick<DocumentGrantClaims, "sub" | "tenantId" | "sessionId">) => Promise<number | null>;
//# sourceMappingURL=documentGrant.d.ts.map