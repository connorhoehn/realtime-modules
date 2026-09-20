/** Narrow user grants for document transports. Service credentials are not user identity. */
import { createPrivateKey, createPublicKey, sign, verify, randomUUID, type KeyObject } from 'node:crypto';

export type DocumentOperation = 'read' | 'comment' | 'edit' | 'manage' | 'seed';
export type DocumentGrantOperation = DocumentOperation;
export interface DocumentGrantClaims {
  iss: string; aud: string; sub: string; tenantId: string; documentId: string;
  operations: DocumentOperation[]; sessionId: string; sessionEpoch: number;
  iat: number; exp: number; jti: string;
}
export interface DocumentGrantVerifierOptions {
  issuer: string;
  audience?: string;
  resolvePublicKey: (kid: string) => string | KeyObject | Promise<string | KeyObject>;
  /** Authoritative lookup on every request/frame. Missing or unavailable sessions fail closed. */
  getSessionEpoch: (claims: DocumentGrantClaims) => number | null | Promise<number | null>;
  now?: () => number;
}
const OPERATIONS: DocumentOperation[] = ['read', 'comment', 'edit', 'manage', 'seed'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function valid(c: any, now: number): c is DocumentGrantClaims {
  return !!c && ['iss', 'aud', 'sub', 'tenantId', 'sessionId', 'jti'].every(k => typeof c[k] === 'string' && c[k].length > 0 && c[k].length <= 512)
    && typeof c.documentId === 'string' && UUID.test(c.documentId)
    && Array.isArray(c.operations) && c.operations.length > 0 && c.operations.every((op: any) => OPERATIONS.includes(op))
    && Number.isSafeInteger(c.sessionEpoch) && c.sessionEpoch >= 0
    && Number.isSafeInteger(c.iat) && Number.isSafeInteger(c.exp)
    && c.iat <= now && c.exp > now && c.exp > c.iat && c.exp - c.iat <= 300;
}
export function createDocumentGrant(
  claims: Omit<DocumentGrantClaims, 'aud' | 'iat' | 'exp' | 'jti'> & Partial<Pick<DocumentGrantClaims, 'aud' | 'iat' | 'exp' | 'jti'>>,
  options: { privateKey: string | KeyObject; keyId: string; now?: () => number },
): string {
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const payload: DocumentGrantClaims = { aud: 'realtime-documents', iat: now, exp: now + 120, jti: randomUUID(), ...claims };
  if (!valid(payload, now) || !options.keyId) throw new Error('Invalid document grant');
  const key = typeof options.privateKey === 'string' ? createPrivateKey(options.privateKey) : options.privateKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Document grants require Ed25519');
  const input = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: options.keyId })).toString('base64url') + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url');
  return input + '.' + sign(null, Buffer.from(input), key).toString('base64url');
}
export async function verifyDocumentGrant(token: string, options: DocumentGrantVerifierOptions): Promise<DocumentGrantClaims> {
  if (typeof token !== 'string' || token.length > 8192) throw new Error('Invalid document grant');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error('Invalid document grant');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT' || typeof header.kid !== 'string' || header.kid.length > 128) throw new Error('Invalid document grant');
  const resolved = await options.resolvePublicKey(header.kid);
  const key = typeof resolved === 'string' ? createPublicKey(resolved) : resolved;
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'))) throw new Error('Invalid document grant signature');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  if (!valid(claims, now) || claims.iss !== options.issuer || claims.aud !== (options.audience ?? 'realtime-documents')) throw new Error('Invalid document grant claims');
  const epoch = await options.getSessionEpoch(claims);
  if (epoch === null || epoch !== claims.sessionEpoch) throw new Error('Document session revoked');
  return claims;
}
export function documentGrantAllows(claims: DocumentGrantClaims, scope: { tenantId: string; documentId: string; operation: DocumentOperation }): boolean {
  return claims.tenantId === scope.tenantId && claims.documentId === scope.documentId && claims.operations.includes(scope.operation);
}
export function createDocumentGrantVerifierFromEnv(
  env: Record<string, string | undefined>,
  options?: Pick<DocumentGrantVerifierOptions, 'getSessionEpoch' | 'now'>,
): ((token: string) => Promise<DocumentGrantClaims>) | null {
  const issuer = env.DOCUMENT_GRANT_ISSUER, pem = env.DOCUMENT_GRANT_PUBLIC_KEY, keyId = env.DOCUMENT_GRANT_KEY_ID;
  if (!issuer && !pem && !keyId) return null;
  if (!issuer || !pem || !keyId) throw new Error('Incomplete document grant verifier configuration');
  const policy = options ?? { getSessionEpoch: createDocumentSessionEpochResolver({ url: env.DOCUMENT_SESSION_EPOCH_URL ?? '', secret: env.DOCUMENT_POLICY_SECRET ?? '' }) };
  const key = createPublicKey(pem.replace(/\\n/g, '\n'));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Document grants require Ed25519');
  return token => verifyDocumentGrant(token, { ...policy, issuer, audience: env.DOCUMENT_GRANT_AUDIENCE,
    resolvePublicKey: kid => { if (kid !== keyId) throw new Error('Unknown document grant key'); return key; } });
}
/** Bounded server-to-server epoch lookup. Never follows redirects carrying a service credential. */
export function createDocumentSessionEpochResolver(options: { url: string; secret: string; fetch?: typeof fetch; timeoutMs?: number }) {
  const url = new URL(options.url);
  if (!options.secret.trim() || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid document session policy configuration');
  const request = options.fetch ?? fetch;
  return async (claims: Pick<DocumentGrantClaims, 'sub' | 'tenantId' | 'sessionId'>): Promise<number | null> => {
    const response = await request(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
      headers: { 'content-type': 'application/json', 'x-document-policy-key': options.secret },
      body: JSON.stringify({ sub: claims.sub, tenantId: claims.tenantId, sessionId: claims.sessionId }) });
    if (!response.ok) throw new Error('Document session policy unavailable');
    const body = await response.json() as { epoch?: unknown };
    if (body.epoch === null) return null;
    if (!Number.isSafeInteger(body.epoch) || (body.epoch as number) < 0) throw new Error('Invalid document session policy response');
    return body.epoch as number;
  };
}
