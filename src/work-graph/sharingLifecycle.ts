import type {
  IsoTimestamp,
  SharingAudience,
  SharingSelection,
  WorkHistoryGrant,
  WorkSharingGrant,
} from './contracts';
import { WORK_GRAPH_SCHEMA_VERSION } from './contracts';

export class SharingRevisionConflictError extends Error {
  constructor() { super('sharing grant revision conflict'); }
}

export class SharingGrantExpiredError extends Error {
  constructor() { super('sharing grant has expired'); }
}

export interface NewSharingGrant {
  id: string;
  organizationId: string;
  ownerId: string;
  audience: SharingAudience;
  selection: SharingSelection;
  expiresAt: IsoTimestamp;
  historyGrantId?: string;
}

export type SharingTransition =
  | { action: 'pause'; expectedRevision: number }
  | { action: 'resume'; expectedRevision: number }
  | { action: 'stop'; expectedRevision: number }
  | { action: 'expire'; expectedRevision: number };

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`${field} must be a valid timestamp`);
  return parsed;
}

export function createSharingGrant(input: NewSharingGrant, now: IsoTimestamp): WorkSharingGrant {
  const nowMs = timestamp(now, 'now');
  if (timestamp(input.expiresAt, 'expiresAt') <= nowMs) throw new SharingGrantExpiredError();
  return {
    schemaVersion: WORK_GRAPH_SCHEMA_VERSION,
    ...input,
    state: 'active',
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
}

export function transitionSharingGrant<T extends WorkSharingGrant | WorkHistoryGrant>(
  grant: T,
  transition: SharingTransition,
  now: IsoTimestamp,
): T {
  if (transition.expectedRevision !== grant.revision) throw new SharingRevisionConflictError();
  const nowMs = timestamp(now, 'now');
  const expired = timestamp(grant.expiresAt, 'expiresAt') <= nowMs;

  if (transition.action === 'resume') {
    if (expired) throw new SharingGrantExpiredError();
    if (grant.state !== 'paused') throw new RangeError('only a paused grant can resume');
  } else if (transition.action === 'pause') {
    if (expired) throw new SharingGrantExpiredError();
    if (grant.state !== 'active') throw new RangeError('only an active grant can pause');
  } else if (transition.action === 'stop') {
    if (grant.state === 'stopped' || grant.state === 'expired') throw new RangeError('grant is already terminal');
  } else if (!expired) {
    throw new RangeError('an unexpired grant cannot transition to expired');
  }

  const state = transition.action === 'expire' ? 'expired' : transition.action === 'resume' ? 'active' : transition.action === 'pause' ? 'paused' : 'stopped';
  return { ...grant, state, updatedAt: now, revision: grant.revision + 1 };
}

/** Read-time expiry is authoritative; database TTL deletion is only cleanup. */
export function effectiveSharingGrant<T extends WorkSharingGrant | WorkHistoryGrant>(
  grant: T,
  now: IsoTimestamp,
): T {
  if (grant.state === 'stopped' || grant.state === 'expired') return grant;
  if (timestamp(grant.expiresAt, 'expiresAt') > timestamp(now, 'now')) return grant;
  return { ...grant, state: 'expired', updatedAt: now, revision: grant.revision + 1 };
}

export interface SharingGrantPair {
  current?: WorkSharingGrant;
  history?: WorkHistoryGrant;
}

/** Current and historical disclosure transition independently. */
export function transitionSharingPair(
  pair: SharingGrantPair,
  target: 'current' | 'history',
  transition: SharingTransition,
  now: IsoTimestamp,
): SharingGrantPair {
  const grant = pair[target];
  if (!grant) throw new RangeError(`${target} grant does not exist`);
  return { ...pair, [target]: transitionSharingGrant(grant, transition, now) };
}
