import type { WorkHistoryGrant } from '../../src/work-graph/contracts';
import { activeSharingGrantFixture } from '../../src/work-graph/fixtures';
import {
  SharingGrantExpiredError,
  SharingRevisionConflictError,
  createSharingGrant,
  effectiveSharingGrant,
  transitionSharingGrant,
  transitionSharingPair,
} from '../../src/work-graph/sharingLifecycle';

describe('sharing lifecycle', () => {
  test('pauses and resumes before expiry without touching work', () => {
    const paused = transitionSharingGrant(activeSharingGrantFixture, { action: 'pause', expectedRevision: 1 }, '2026-09-19T14:00:00.000Z');
    expect(paused).toMatchObject({ state: 'paused', revision: 2 });
    const resumed = transitionSharingGrant(paused, { action: 'resume', expectedRevision: 2 }, '2026-09-19T14:01:00.000Z');
    expect(resumed).toMatchObject({ state: 'active', revision: 3 });
  });

  test('denies resume after expiry and expires at read time', () => {
    const paused = { ...activeSharingGrantFixture, state: 'paused' as const };
    expect(() => transitionSharingGrant(paused, { action: 'resume', expectedRevision: 1 }, '2026-09-20T00:00:00.000Z')).toThrow(SharingGrantExpiredError);
    expect(effectiveSharingGrant(activeSharingGrantFixture, '2026-09-20T00:00:00.000Z').state).toBe('expired');
  });

  test('stopping is terminal and restarting creates a different grant', () => {
    const stopped = transitionSharingGrant(activeSharingGrantFixture, { action: 'stop', expectedRevision: 1 }, '2026-09-19T14:00:00.000Z');
    expect(stopped.state).toBe('stopped');
    expect(() => transitionSharingGrant(stopped, { action: 'resume', expectedRevision: 2 }, '2026-09-19T14:01:00.000Z')).toThrow();
    const restarted = createSharingGrant({
      id: 'wg_grant_restarted', organizationId: stopped.organizationId, ownerId: stopped.ownerId,
      audience: stopped.audience, selection: stopped.selection, expiresAt: '2026-09-19T22:00:00.000Z',
    }, '2026-09-19T14:01:00.000Z');
    expect(restarted.id).not.toBe(stopped.id);
    expect(restarted.revision).toBe(1);
  });

  test('rejects stale concurrent edits', () => {
    expect(() => transitionSharingGrant(activeSharingGrantFixture, { action: 'pause', expectedRevision: 0 }, '2026-09-19T14:00:00.000Z')).toThrow(SharingRevisionConflictError);
  });

  test('keeps the explicit history grant independent', () => {
    const history: WorkHistoryGrant = {
      ...activeSharingGrantFixture,
      id: 'wg_history_fixture', dayFrom: '2026-09-18', dayThrough: '2026-09-19',
    };
    const pair = transitionSharingPair({ current: activeSharingGrantFixture, history }, 'current', { action: 'stop', expectedRevision: 1 }, '2026-09-19T14:00:00.000Z');
    expect(pair.current?.state).toBe('stopped');
    expect(pair.history).toEqual(history);
  });
});
