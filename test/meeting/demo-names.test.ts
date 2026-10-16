// Goal G6: demo content is fictional. The reference picture was a real
// meeting; none of its people's names belong in tests or docs.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const DIRS = ['src/meeting', 'src/client/meeting', 'test/meeting', 'test/client/meeting', 'test/e2e-media'];
const DOCS = ['docs/design/meeting-rooms.md', 'docs/recipes/meetings.md'];
const REFERENCE = /Digisha|Prakashchandra|Hilla|Lauren Milosky|Neal Patel|Sanjay Ramanathan|Ivan Nunez|Parker Watson|Fabian Jimenez|Greg Mikels|Kiana Bahramian|Eli Galayda|Yifei Wang|Abhishek Bhardwaj|Chandan Vedavyas|Jeff Averill|Jeff's Room/;

function files(dir: string): string[] {
    const abs = join(root, dir);
    return readdirSync(abs).flatMap((name) => {
        const p = join(abs, name);
        return statSync(p).isDirectory() ? files(join(dir, name)) : [join(dir, name)];
    });
}

describe('meeting demo content', () => {
    it('uses no name from the reference screenshot', () => {
        const hits = [...DIRS.flatMap(files), ...DOCS]
            .filter((f) => f !== 'test/meeting/demo-names.test.ts')
            .filter((f) => REFERENCE.test(readFileSync(join(root, f), 'utf8')));
        expect(hits).toEqual([]);
    });
});
