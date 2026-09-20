"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDocumentGrant = createDocumentGrant;
exports.verifyDocumentGrant = verifyDocumentGrant;
exports.documentGrantAllows = documentGrantAllows;
exports.createDocumentGrantVerifierFromEnv = createDocumentGrantVerifierFromEnv;
exports.createDocumentSessionEpochResolver = createDocumentSessionEpochResolver;
/** Narrow user grants for document transports. Service credentials are not user identity. */
const node_crypto_1 = require("node:crypto");
const OPERATIONS = ['read', 'comment', 'edit', 'manage', 'seed'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function valid(c, now) {
    return !!c && ['iss', 'aud', 'sub', 'tenantId', 'sessionId', 'jti'].every(k => typeof c[k] === 'string' && c[k].length > 0 && c[k].length <= 512)
        && typeof c.documentId === 'string' && UUID.test(c.documentId)
        && Array.isArray(c.operations) && c.operations.length > 0 && c.operations.every((op) => OPERATIONS.includes(op))
        && (c.seedOwnerSub === undefined || (typeof c.seedOwnerSub === 'string' && c.seedOwnerSub.length > 0 && c.seedOwnerSub.length <= 512 && c.operations.length === 1 && c.operations[0] === 'seed'))
        && Number.isSafeInteger(c.sessionEpoch) && c.sessionEpoch >= 0
        && Number.isSafeInteger(c.iat) && Number.isSafeInteger(c.exp)
        && c.iat <= now && c.exp > now && c.exp > c.iat && c.exp - c.iat <= 300;
}
function createDocumentGrant(claims, options) {
    const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
    const payload = { aud: 'realtime-documents', iat: now, exp: now + 120, jti: (0, node_crypto_1.randomUUID)(), ...claims };
    if (!valid(payload, now) || !options.keyId)
        throw new Error('Invalid document grant');
    const key = typeof options.privateKey === 'string' ? (0, node_crypto_1.createPrivateKey)(options.privateKey) : options.privateKey;
    if (key.asymmetricKeyType !== 'ed25519')
        throw new Error('Document grants require Ed25519');
    const input = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: options.keyId })).toString('base64url') + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url');
    return input + '.' + (0, node_crypto_1.sign)(null, Buffer.from(input), key).toString('base64url');
}
async function verifyDocumentGrant(token, options) {
    if (typeof token !== 'string' || token.length > 8192)
        throw new Error('Invalid document grant');
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p)))
        throw new Error('Invalid document grant');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (header.alg !== 'EdDSA' || header.typ !== 'JWT' || typeof header.kid !== 'string' || header.kid.length > 128)
        throw new Error('Invalid document grant');
    const resolved = await options.resolvePublicKey(header.kid);
    const key = typeof resolved === 'string' ? (0, node_crypto_1.createPublicKey)(resolved) : resolved;
    if (key.asymmetricKeyType !== 'ed25519' || !(0, node_crypto_1.verify)(null, Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url')))
        throw new Error('Invalid document grant signature');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
    if (!valid(claims, now) || claims.iss !== options.issuer || claims.aud !== (options.audience ?? 'realtime-documents'))
        throw new Error('Invalid document grant claims');
    const epoch = await options.getSessionEpoch(claims);
    if (!valid(claims, Math.floor((options.now?.() ?? Date.now()) / 1000)))
        throw new Error('Document grant expired during verification');
    if (epoch === null || epoch !== claims.sessionEpoch)
        throw new Error('Document session revoked');
    return claims;
}
function documentGrantAllows(claims, scope) {
    return claims.tenantId === scope.tenantId && claims.documentId === scope.documentId && claims.operations.includes(scope.operation);
}
function createDocumentGrantVerifierFromEnv(env, options) {
    const issuer = env.DOCUMENT_GRANT_ISSUER, pem = env.DOCUMENT_GRANT_PUBLIC_KEY, keyId = env.DOCUMENT_GRANT_KEY_ID;
    if (pem?.includes('PRIVATE KEY'))
        throw new Error('Document verifier must receive only a public key');
    if (!issuer && !pem && !keyId)
        return null;
    if (!issuer || !pem || !keyId)
        throw new Error('Incomplete document grant verifier configuration');
    const policy = options ?? { getSessionEpoch: createDocumentSessionEpochResolver({ url: env.DOCUMENT_SESSION_EPOCH_URL ?? '', secret: env.DOCUMENT_POLICY_SECRET ?? '' }) };
    const key = (0, node_crypto_1.createPublicKey)(pem.replace(/\\n/g, '\n'));
    if (key.asymmetricKeyType !== 'ed25519')
        throw new Error('Document grants require Ed25519');
    return token => verifyDocumentGrant(token, { ...policy, issuer, audience: env.DOCUMENT_GRANT_AUDIENCE,
        resolvePublicKey: kid => { if (kid !== keyId)
            throw new Error('Unknown document grant key'); return key; } });
}
/** Bounded server-to-server epoch lookup. Never follows redirects carrying a service credential. */
function createDocumentSessionEpochResolver(options) {
    const url = new URL(options.url);
    if (!options.secret.trim() || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Invalid document session policy configuration');
    const request = options.fetch ?? fetch;
    return async (claims) => {
        const response = await request(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
            headers: { 'content-type': 'application/json', 'x-document-policy-key': options.secret },
            body: JSON.stringify({ sub: claims.sub, tenantId: claims.tenantId, sessionId: claims.sessionId }) });
        if (!response.ok)
            throw new Error('Document session policy unavailable');
        const body = await response.json();
        if (body.epoch === null)
            return null;
        if (!Number.isSafeInteger(body.epoch) || body.epoch < 0)
            throw new Error('Invalid document session policy response');
        return body.epoch;
    };
}
//# sourceMappingURL=documentGrant.js.map