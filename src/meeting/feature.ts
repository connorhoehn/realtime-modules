// realtime-modules/src/meeting/feature.ts
//
// `meeting()` for attachRealtime. It lives with the service (not in
// server/attach.ts's built-ins) and is re-exported from ./server, so it plugs
// in exactly like the built-ins:
//
//   attachRealtime(server, { features: [calls(), meeting({ isOrganizer })], auth });

import type { RealtimeFeature } from '../server/attach';
import { MeetingManifest } from './manifest';
import { MeetingService } from './MeetingService';
import type { MeetingConfig, MeetingLogger, MeetingRouter } from './types';

export function meeting(opts: MeetingConfig = {}): RealtimeFeature {
    return {
        manifest: MeetingManifest,
        serviceName: 'meeting',
        create: ({ router, logger }) =>
            new MeetingService({
                router: router as unknown as MeetingRouter,
                logger: logger as unknown as MeetingLogger,
                config: opts,
            }),
    };
}
