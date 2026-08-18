"use strict";
// realtime-modules/src/notification/constants.ts
//
// Notification-service tunables. Kept local to the notification module
// (rather than in the shared src/config/constants.ts) so this feature is
// self-contained — the whole surface lands under one directory.
//
// Caps mirror the activity-feed precedent (ACTIVITY_MAX_HISTORY_ITEMS = 200)
// because notifications are the same recent-window inbox shape. The TTL is
// 30 days: long enough that a user returning after a week still sees their
// unread set, short enough that abandoned inboxes self-reap.
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOTIFICATION_TTL_SEC = exports.NOTIFICATION_MAX_PER_USER = void 0;
/** Max notifications retained per user. Older entries are trimmed on add. */
exports.NOTIFICATION_MAX_PER_USER = 200;
/** Rolling TTL (seconds) refreshed on every write. 30 days. */
exports.NOTIFICATION_TTL_SEC = 30 * 24 * 60 * 60;
//# sourceMappingURL=constants.js.map