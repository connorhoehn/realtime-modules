"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SharingGrantExpiredError = exports.SharingRevisionConflictError = void 0;
exports.createSharingGrant = createSharingGrant;
exports.transitionSharingGrant = transitionSharingGrant;
exports.effectiveSharingGrant = effectiveSharingGrant;
exports.transitionSharingPair = transitionSharingPair;
const contracts_1 = require("./contracts");
class SharingRevisionConflictError extends Error {
    constructor() { super('sharing grant revision conflict'); }
}
exports.SharingRevisionConflictError = SharingRevisionConflictError;
class SharingGrantExpiredError extends Error {
    constructor() { super('sharing grant has expired'); }
}
exports.SharingGrantExpiredError = SharingGrantExpiredError;
function timestamp(value, field) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed))
        throw new RangeError(`${field} must be a valid timestamp`);
    return parsed;
}
function createSharingGrant(input, now) {
    const nowMs = timestamp(now, 'now');
    if (timestamp(input.expiresAt, 'expiresAt') <= nowMs)
        throw new SharingGrantExpiredError();
    return {
        schemaVersion: contracts_1.WORK_GRAPH_SCHEMA_VERSION,
        ...input,
        state: 'active',
        createdAt: now,
        updatedAt: now,
        revision: 1,
    };
}
function transitionSharingGrant(grant, transition, now) {
    if (transition.expectedRevision !== grant.revision)
        throw new SharingRevisionConflictError();
    const nowMs = timestamp(now, 'now');
    const expired = timestamp(grant.expiresAt, 'expiresAt') <= nowMs;
    if (transition.action === 'resume') {
        if (expired)
            throw new SharingGrantExpiredError();
        if (grant.state !== 'paused')
            throw new RangeError('only a paused grant can resume');
    }
    else if (transition.action === 'pause') {
        if (expired)
            throw new SharingGrantExpiredError();
        if (grant.state !== 'active')
            throw new RangeError('only an active grant can pause');
    }
    else if (transition.action === 'stop') {
        if (grant.state === 'stopped' || grant.state === 'expired')
            throw new RangeError('grant is already terminal');
    }
    else if (!expired) {
        throw new RangeError('an unexpired grant cannot transition to expired');
    }
    const state = transition.action === 'expire' ? 'expired' : transition.action === 'resume' ? 'active' : transition.action === 'pause' ? 'paused' : 'stopped';
    return { ...grant, state, updatedAt: now, revision: grant.revision + 1 };
}
/** Read-time expiry is authoritative; database TTL deletion is only cleanup. */
function effectiveSharingGrant(grant, now) {
    if (grant.state === 'stopped' || grant.state === 'expired')
        return grant;
    if (timestamp(grant.expiresAt, 'expiresAt') > timestamp(now, 'now'))
        return grant;
    return { ...grant, state: 'expired', updatedAt: now, revision: grant.revision + 1 };
}
/** Current and historical disclosure transition independently. */
function transitionSharingPair(pair, target, transition, now) {
    const grant = pair[target];
    if (!grant)
        throw new RangeError(`${target} grant does not exist`);
    return { ...pair, [target]: transitionSharingGrant(grant, transition, now) };
}
//# sourceMappingURL=sharingLifecycle.js.map