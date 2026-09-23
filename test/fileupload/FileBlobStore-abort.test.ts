import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { FileBlobStore } from '../../src/fileupload/FileBlobStore';

// realtime-examples NFR #91: an aborted upload must leave no file behind. The
// write stream opens asynchronously; unlinking before it closed let the late
// open re-create an empty blob (3 of 20 aborts before the fix).
describe('FileBlobStore.putStream abort', () => {
  it('leaves no blob behind for any over-cap or errored upload, however the open races the abort', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-abort-'));
    const store = new FileBlobStore({ baseDir: dir });
    for (let i = 0; i < 40; i++) {
      const over = store.putStream(`over-${i}`, Readable.from([Buffer.from('way too many bytes')]), 8);
      await expect(over).rejects.toMatchObject({ code: 'TOO_LARGE' });
      expect(await store.stat(`over-${i}`)).toBeNull();

      let sent = false;
      const broken = new Readable({
        read() {
          if (sent) return;
          sent = true;
          this.push(Buffer.from('partial'));
          process.nextTick(() => this.destroy(new Error('socket hangup')));
        },
      });
      await expect(store.putStream(`err-${i}`, broken, 1024)).rejects.toThrow('socket hangup');
      expect(await store.stat(`err-${i}`)).toBeNull();
    }
  });
});
