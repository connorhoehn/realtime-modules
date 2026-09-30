// No-migration proof: realtime-examples could swap its chat repositories for
// DynamoChatStore and keep its tables. The same scenario (parity/scenario.js
// — every write, read, update, TTL, conversations-index write and the
// server.ts hook maintenance, the DM-edit and card-patch paths included) runs
// against both implementations with the same clock and canned DynamoDB
// answers; the commands sent and the values resolved must be identical.
//
//   1. Always: the library against the committed transcript the app's
//      repositories produced (parity/realtime-examples-transcript.json).
//   2. When a realtime-examples checkout is beside this one (or at
//      REALTIME_EXAMPLES_DIR): the app's CURRENT repositories, run live via
//      parity/app-driver.js inside that checkout.

import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { DynamoChatStore } from '../../../src/server/stores/dynamo';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runScenario } = require('./parity/run');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const golden = require('./parity/realtime-examples-transcript.json');

const libraryTranscript = () => runScenario((client: any, op: any) => {
    const store = new DynamoChatStore({ client, logger: { warn() {} } });
    const hooks = store.chatOptions({ channelRecipients: () => op.recipients ?? [] });
    return {
        messages: store,
        conversations: store.conversations,
        members: store.members,
        reads: store.reads,
        hooks: {
            ...hooks,
            indexSystemMessage: (channel: string, posted: any) => store.conversations.recordSystemMessage(channel, posted),
        },
    };
});

const appDir = path.resolve(process.env.REALTIME_EXAMPLES_DIR ?? path.join(__dirname, '../../../../realtime-examples'));
const appAdapters = path.join(appDir, 'src/realtime-fanout/chat/adapters/DdbChatStore.ts');
const hasApp = existsSync(appAdapters) && existsSync(path.join(appDir, 'node_modules/ts-node'));

describe("DynamoChatStore ≡ realtime-examples' chat repositories", () => {
    it('matches the committed app transcript op for op', async () => {
        const lib = await libraryTranscript();
        expect(lib.map((e: any) => e.op)).toEqual(golden.transcript.map((e: any) => e.op));
        for (let i = 0; i < lib.length; i++) expect({ i, ...lib[i] }).toEqual({ i, ...golden.transcript[i] });
    });

    (hasApp ? it : it.skip)('matches the app repositories as they are today (live)', async () => {
        const out = execFileSync(process.execPath, [path.join(__dirname, 'parity/app-driver.js'), appDir], {
            cwd: appDir,
            encoding: 'utf8',
            timeout: 60_000,
        });
        const app = JSON.parse(out);
        const lib = await libraryTranscript();
        for (let i = 0; i < Math.max(app.length, lib.length); i++) expect({ i, ...lib[i] }).toEqual({ i, ...app[i] });
    }, 90_000);
});
