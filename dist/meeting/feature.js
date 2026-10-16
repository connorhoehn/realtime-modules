"use strict";
// realtime-modules/src/meeting/feature.ts
//
// `meeting()` for attachRealtime. It lives with the service (not in
// server/attach.ts's built-ins) and is re-exported from ./server, so it plugs
// in exactly like the built-ins:
//
//   attachRealtime(server, { features: [calls(), meeting({ isOrganizer })], auth });
Object.defineProperty(exports, "__esModule", { value: true });
exports.meeting = meeting;
const manifest_1 = require("./manifest");
const MeetingService_1 = require("./MeetingService");
function meeting(opts = {}) {
    return {
        manifest: manifest_1.MeetingManifest,
        serviceName: 'meeting',
        create: ({ router, logger }) => new MeetingService_1.MeetingService({
            router: router,
            logger: logger,
            config: opts,
        }),
    };
}
//# sourceMappingURL=feature.js.map