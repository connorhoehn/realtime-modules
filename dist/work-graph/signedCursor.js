"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WORK_GRAPH_REPLAY_MAX_AGE_MS = exports.WorkGraphCursorCodec = exports.WorkGraphCursorError = void 0;
const node_crypto_1 = require("node:crypto");
const validationV2_1 = require("./validationV2");
const TOKEN_PREFIX = 'wg1';
const TOKEN_PREFIX_V2 = 'wg2';
const MAX_TOKEN_BYTES = 8 * 1024;
const MAX_REPLAY_AGE_MS = 15 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 30 * 1_000;
class WorkGraphCursorError extends Error {
    reason;
    constructor(reason) {
        super(`Invalid work-graph cursor: ${reason}`);
        this.reason = reason;
        this.name = 'WorkGraphCursorError';
    }
}
exports.WorkGraphCursorError = WorkGraphCursorError;
function nonEmpty(value) {
    return typeof value === 'string' && value.length > 0;
}
function exactKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key))
        && allowed.every((key) => key === 'pageOffset' || Object.prototype.hasOwnProperty.call(value, key));
}
function decodeClaims(payload) {
    let value;
    try {
        value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    }
    catch {
        throw new WorkGraphCursorError('invalid-claims');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new WorkGraphCursorError('invalid-claims');
    const record = value;
    if (!exactKeys(record, [
        'schemaVersion', 'organizationId', 'viewerId', 'personId', 'day',
        'timezone', 'policyRevision', 'watermark', 'subscriptionGeneration',
        'issuedAt', 'expiresAt', 'pageOffset',
    ])
        || record.schemaVersion !== 1
        || !nonEmpty(record.organizationId)
        || !nonEmpty(record.viewerId)
        || !nonEmpty(record.personId)
        || !nonEmpty(record.day)
        || !/^\d{4}-\d{2}-\d{2}$/.test(record.day)
        || !nonEmpty(record.timezone)
        || !nonEmpty(record.policyRevision)
        || !Number.isSafeInteger(record.watermark)
        || Number(record.watermark) < 0
        || !nonEmpty(record.subscriptionGeneration)
        || !nonEmpty(record.issuedAt)
        || !nonEmpty(record.expiresAt)
        || !Number.isFinite(Date.parse(record.issuedAt))
        || !Number.isFinite(Date.parse(record.expiresAt))
        || (record.pageOffset !== undefined && !nonEmpty(record.pageOffset))) {
        throw new WorkGraphCursorError('invalid-claims');
    }
    return record;
}
function decodeClaimsV2(payload) {
    let value;
    try {
        value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    }
    catch {
        throw new WorkGraphCursorError('invalid-claims');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new WorkGraphCursorError('invalid-claims');
    const record = value;
    const allowed = [
        'schemaVersion', 'organizationId', 'viewerId', 'personId', 'day', 'timezone',
        'policyRevision', 'query', 'partitions', 'observationWatermark',
        'subscriptionGeneration', 'issuedAt', 'expiresAt', 'pageOffset',
    ];
    const partitions = record.partitions;
    if (!Object.keys(record).every((key) => allowed.includes(key))
        || !allowed.every((key) => key === 'pageOffset' || Object.prototype.hasOwnProperty.call(record, key))
        || record.schemaVersion !== 2
        || !nonEmpty(record.organizationId)
        || !nonEmpty(record.viewerId)
        || !nonEmpty(record.personId)
        || !nonEmpty(record.day)
        || !/^\d{4}-\d{2}-\d{2}$/.test(record.day)
        || !nonEmpty(record.timezone)
        || !nonEmpty(record.policyRevision)
        || !(0, validationV2_1.validateWorkGraphQueryV2)(record.query).ok
        || !Array.isArray(partitions)
        || partitions.length === 0
        || partitions.length > 2
        || !partitions.every((partition) => partition
            && typeof partition === 'object'
            && !Array.isArray(partition)
            && Object.keys(partition).length === 2
            && /^\d{4}-\d{2}-\d{2}$/.test(String(partition.utcDay))
            && Number.isSafeInteger(partition.watermark)
            && Number(partition.watermark) >= 0)
        || new Set(partitions.map((partition) => partition.utcDay)).size !== partitions.length
        || !Number.isSafeInteger(record.observationWatermark)
        || Number(record.observationWatermark) < 0
        || !nonEmpty(record.subscriptionGeneration)
        || !nonEmpty(record.issuedAt)
        || !nonEmpty(record.expiresAt)
        || !Number.isFinite(Date.parse(record.issuedAt))
        || !Number.isFinite(Date.parse(record.expiresAt))
        || (record.pageOffset !== undefined && !nonEmpty(record.pageOffset))) {
        throw new WorkGraphCursorError('invalid-claims');
    }
    const claims = record;
    // The cursor is bound to the whole authorized query, not just the scope, so
    // a token cannot be replayed against a different person, day or interval.
    if (claims.query.personId !== claims.personId
        || claims.query.day !== claims.day
        || claims.query.timezone !== claims.timezone) {
        throw new WorkGraphCursorError('invalid-claims');
    }
    return claims;
}
function sameScope(claims, expected) {
    return claims.organizationId === expected.organizationId
        && claims.viewerId === expected.viewerId
        && claims.personId === expected.personId
        && claims.day === expected.day
        && claims.timezone === expected.timezone
        && claims.policyRevision === expected.policyRevision;
}
/** Shared issuer/verifier used by the platform snapshot API and gateway. */
class WorkGraphCursorCodec {
    secret;
    now;
    maximumAgeMs;
    constructor(options) {
        this.secret = Buffer.isBuffer(options.secret) ? Buffer.from(options.secret) : Buffer.from(options.secret, 'utf8');
        if (this.secret.byteLength < 32)
            throw new Error('WorkGraphCursorCodec secret must contain at least 32 bytes');
        this.now = options.now ?? Date.now;
        this.maximumAgeMs = options.maximumAgeMs ?? MAX_REPLAY_AGE_MS;
        if (!Number.isSafeInteger(this.maximumAgeMs) || this.maximumAgeMs <= 0 || this.maximumAgeMs > MAX_REPLAY_AGE_MS) {
            throw new Error(`maximumAgeMs must be between 1 and ${MAX_REPLAY_AGE_MS}`);
        }
    }
    issue(input) {
        if (!Number.isSafeInteger(input.watermark) || input.watermark < 0)
            throw new Error('watermark must be a non-negative safe integer');
        if (!nonEmpty(input.subscriptionGeneration))
            throw new Error('subscriptionGeneration is required');
        const issuedAtMs = this.now();
        const maximumExpiryMs = issuedAtMs + this.maximumAgeMs;
        const expiryMs = input.expiresAt === undefined ? maximumExpiryMs : Date.parse(input.expiresAt);
        if (!Number.isFinite(expiryMs) || expiryMs <= issuedAtMs || expiryMs > maximumExpiryMs) {
            throw new Error('expiresAt must be after issue time and within the replay window');
        }
        const claims = {
            schemaVersion: 1,
            ...input.scope,
            watermark: input.watermark,
            subscriptionGeneration: input.subscriptionGeneration,
            issuedAt: new Date(issuedAtMs).toISOString(),
            expiresAt: new Date(expiryMs).toISOString(),
            ...(input.pageOffset === undefined ? {} : { pageOffset: input.pageOffset }),
        };
        const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
        const signed = `${TOKEN_PREFIX}.${payload}`;
        const signature = (0, node_crypto_1.createHmac)('sha256', this.secret).update(signed, 'utf8').digest('base64url');
        return `${signed}.${signature}`;
    }
    /**
     * Issues a composite v2 cursor. The v1 `issue` is untouched, and a v1
     * verifier still rejects this token because the prefix differs.
     */
    issueV2(input) {
        if (!Number.isSafeInteger(input.observationWatermark) || input.observationWatermark < 0) {
            throw new Error('observationWatermark must be a non-negative safe integer');
        }
        if (!nonEmpty(input.subscriptionGeneration))
            throw new Error('subscriptionGeneration is required');
        if (!(0, validationV2_1.validateWorkGraphQueryV2)(input.query).ok)
            throw new Error('query must be a valid v2 work graph query');
        if (input.partitions.length === 0 || input.partitions.length > 2) {
            throw new Error('a local day covers one or two UTC partitions');
        }
        const issuedAtMs = this.now();
        const maximumExpiryMs = issuedAtMs + this.maximumAgeMs;
        const expiryMs = input.expiresAt === undefined ? maximumExpiryMs : Date.parse(input.expiresAt);
        if (!Number.isFinite(expiryMs) || expiryMs <= issuedAtMs || expiryMs > maximumExpiryMs) {
            throw new Error('expiresAt must be after issue time and within the replay window');
        }
        const claims = {
            schemaVersion: 2,
            ...input.scope,
            query: input.query,
            partitions: input.partitions.map((partition) => ({ utcDay: partition.utcDay, watermark: partition.watermark })),
            observationWatermark: input.observationWatermark,
            subscriptionGeneration: input.subscriptionGeneration,
            issuedAt: new Date(issuedAtMs).toISOString(),
            expiresAt: new Date(expiryMs).toISOString(),
            ...(input.pageOffset === undefined ? {} : { pageOffset: input.pageOffset }),
        };
        const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
        const signed = `${TOKEN_PREFIX_V2}.${payload}`;
        const signature = (0, node_crypto_1.createHmac)('sha256', this.secret).update(signed, 'utf8').digest('base64url');
        return `${signed}.${signature}`;
    }
    /** Verifies a v2 cursor. A v1 token is rejected here, and the reverse holds. */
    verifyV2(token, expectedScope, expectedQuery) {
        const payload = this.authenticate(token, TOKEN_PREFIX_V2);
        const claims = decodeClaimsV2(payload);
        this.assertFresh(claims.issuedAt, claims.expiresAt);
        if (expectedScope && !sameScope(claims, expectedScope))
            throw new WorkGraphCursorError('scope-mismatch');
        if (expectedQuery && (claims.query.windowStart !== expectedQuery.windowStart
            || claims.query.windowEnd !== expectedQuery.windowEnd
            || claims.query.mode !== expectedQuery.mode
            || claims.query.personId !== expectedQuery.personId
            || claims.query.day !== expectedQuery.day
            || claims.query.timezone !== expectedQuery.timezone)) {
            throw new WorkGraphCursorError('scope-mismatch');
        }
        return claims;
    }
    /** Constant-time signature check shared by both versions. */
    authenticate(token, prefix) {
        if (!nonEmpty(token) || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES)
            throw new WorkGraphCursorError('malformed');
        const parts = token.split('.');
        if (parts.length !== 3 || parts[0] !== prefix || !parts[1] || !parts[2]
            || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) {
            throw new WorkGraphCursorError('malformed');
        }
        const signed = `${parts[0]}.${parts[1]}`;
        const expectedMac = (0, node_crypto_1.createHmac)('sha256', this.secret).update(signed, 'utf8').digest();
        let receivedMac;
        try {
            receivedMac = Buffer.from(parts[2], 'base64url');
        }
        catch {
            throw new WorkGraphCursorError('malformed');
        }
        if (receivedMac.length !== expectedMac.length || !(0, node_crypto_1.timingSafeEqual)(receivedMac, expectedMac)) {
            throw new WorkGraphCursorError('invalid-signature');
        }
        return parts[1];
    }
    assertFresh(issuedAtIso, expiresAtIso) {
        const now = this.now();
        const issuedAt = Date.parse(issuedAtIso);
        const expiresAt = Date.parse(expiresAtIso);
        if (issuedAt > now + MAX_CLOCK_SKEW_MS || expiresAt <= now || expiresAt - issuedAt > this.maximumAgeMs) {
            throw new WorkGraphCursorError('expired');
        }
    }
    verify(token, expectedScope) {
        if (!nonEmpty(token) || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES)
            throw new WorkGraphCursorError('malformed');
        const parts = token.split('.');
        if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]
            || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) {
            throw new WorkGraphCursorError('malformed');
        }
        const signed = `${parts[0]}.${parts[1]}`;
        const expectedMac = (0, node_crypto_1.createHmac)('sha256', this.secret).update(signed, 'utf8').digest();
        let receivedMac;
        try {
            receivedMac = Buffer.from(parts[2], 'base64url');
        }
        catch {
            throw new WorkGraphCursorError('malformed');
        }
        if (receivedMac.length !== expectedMac.length || !(0, node_crypto_1.timingSafeEqual)(receivedMac, expectedMac)) {
            throw new WorkGraphCursorError('invalid-signature');
        }
        const claims = decodeClaims(parts[1]);
        const now = this.now();
        const issuedAt = Date.parse(claims.issuedAt);
        const expiresAt = Date.parse(claims.expiresAt);
        if (issuedAt > now + MAX_CLOCK_SKEW_MS || expiresAt <= now || expiresAt - issuedAt > this.maximumAgeMs) {
            throw new WorkGraphCursorError('expired');
        }
        if (expectedScope && !sameScope(claims, expectedScope))
            throw new WorkGraphCursorError('scope-mismatch');
        return claims;
    }
}
exports.WorkGraphCursorCodec = WorkGraphCursorCodec;
exports.WORK_GRAPH_REPLAY_MAX_AGE_MS = MAX_REPLAY_AGE_MS;
//# sourceMappingURL=signedCursor.js.map