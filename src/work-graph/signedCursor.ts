import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WorkGraphCursorClaims, WorkGraphQueryScope } from './contracts';

const TOKEN_PREFIX = 'wg1';
const MAX_TOKEN_BYTES = 8 * 1024;
const MAX_REPLAY_AGE_MS = 15 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 30 * 1_000;

export type WorkGraphCursorFailure =
  | 'malformed'
  | 'invalid-signature'
  | 'invalid-claims'
  | 'expired'
  | 'scope-mismatch';

export class WorkGraphCursorError extends Error {
  constructor(readonly reason: WorkGraphCursorFailure) {
    super(`Invalid work-graph cursor: ${reason}`);
    this.name = 'WorkGraphCursorError';
  }
}

export interface WorkGraphCursorCodecOptions {
  secret: string | Buffer;
  now?: () => number;
  maximumAgeMs?: number;
}

export interface IssueWorkGraphCursorInput {
  scope: WorkGraphQueryScope;
  watermark: number;
  subscriptionGeneration: string;
  pageOffset?: string;
  expiresAt?: string;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
    && allowed.every((key) => key === 'pageOffset' || Object.prototype.hasOwnProperty.call(value, key));
}

function decodeClaims(payload: string): WorkGraphCursorClaims {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new WorkGraphCursorError('invalid-claims');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkGraphCursorError('invalid-claims');
  const record = value as Record<string, unknown>;
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
  return record as unknown as WorkGraphCursorClaims;
}

function sameScope(claims: WorkGraphCursorClaims, expected: WorkGraphQueryScope): boolean {
  return claims.organizationId === expected.organizationId
    && claims.viewerId === expected.viewerId
    && claims.personId === expected.personId
    && claims.day === expected.day
    && claims.timezone === expected.timezone
    && claims.policyRevision === expected.policyRevision;
}

/** Shared issuer/verifier used by the platform snapshot API and gateway. */
export class WorkGraphCursorCodec {
  private readonly secret: Buffer;
  private readonly now: () => number;
  private readonly maximumAgeMs: number;

  constructor(options: WorkGraphCursorCodecOptions) {
    this.secret = Buffer.isBuffer(options.secret) ? Buffer.from(options.secret) : Buffer.from(options.secret, 'utf8');
    if (this.secret.byteLength < 32) throw new Error('WorkGraphCursorCodec secret must contain at least 32 bytes');
    this.now = options.now ?? Date.now;
    this.maximumAgeMs = options.maximumAgeMs ?? MAX_REPLAY_AGE_MS;
    if (!Number.isSafeInteger(this.maximumAgeMs) || this.maximumAgeMs <= 0 || this.maximumAgeMs > MAX_REPLAY_AGE_MS) {
      throw new Error(`maximumAgeMs must be between 1 and ${MAX_REPLAY_AGE_MS}`);
    }
  }

  issue(input: IssueWorkGraphCursorInput): string {
    if (!Number.isSafeInteger(input.watermark) || input.watermark < 0) throw new Error('watermark must be a non-negative safe integer');
    if (!nonEmpty(input.subscriptionGeneration)) throw new Error('subscriptionGeneration is required');
    const issuedAtMs = this.now();
    const maximumExpiryMs = issuedAtMs + this.maximumAgeMs;
    const expiryMs = input.expiresAt === undefined ? maximumExpiryMs : Date.parse(input.expiresAt);
    if (!Number.isFinite(expiryMs) || expiryMs <= issuedAtMs || expiryMs > maximumExpiryMs) {
      throw new Error('expiresAt must be after issue time and within the replay window');
    }
    const claims: WorkGraphCursorClaims = {
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
    const signature = createHmac('sha256', this.secret).update(signed, 'utf8').digest('base64url');
    return `${signed}.${signature}`;
  }

  verify(token: string, expectedScope?: WorkGraphQueryScope): WorkGraphCursorClaims {
    if (!nonEmpty(token) || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) throw new WorkGraphCursorError('malformed');
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]
      || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) {
      throw new WorkGraphCursorError('malformed');
    }
    const signed = `${parts[0]}.${parts[1]}`;
    const expectedMac = createHmac('sha256', this.secret).update(signed, 'utf8').digest();
    let receivedMac: Buffer;
    try {
      receivedMac = Buffer.from(parts[2], 'base64url');
    } catch {
      throw new WorkGraphCursorError('malformed');
    }
    if (receivedMac.length !== expectedMac.length || !timingSafeEqual(receivedMac, expectedMac)) {
      throw new WorkGraphCursorError('invalid-signature');
    }
    const claims = decodeClaims(parts[1]);
    const now = this.now();
    const issuedAt = Date.parse(claims.issuedAt);
    const expiresAt = Date.parse(claims.expiresAt);
    if (issuedAt > now + MAX_CLOCK_SKEW_MS || expiresAt <= now || expiresAt - issuedAt > this.maximumAgeMs) {
      throw new WorkGraphCursorError('expired');
    }
    if (expectedScope && !sameScope(claims, expectedScope)) throw new WorkGraphCursorError('scope-mismatch');
    return claims;
  }
}

export const WORK_GRAPH_REPLAY_MAX_AGE_MS = MAX_REPLAY_AGE_MS;
