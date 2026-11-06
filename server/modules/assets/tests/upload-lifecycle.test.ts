import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cancelAttachmentUpload, expireUnsentAttachments, retainAttachmentUploads, storeAttachmentChunk } from '@/modules/assets/services/chunk-upload.service.js';

test('managed uploads delete immediately, reject late chunks, expire after one hour, and preserve sent files', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-attachment-lease-'));
  t.mock.method(os, 'homedir', () => home);
  const upload = (uploadId: string) => storeAttachmentChunk({ userId: 1, uploadId, index: 0, totalSize: 4, name: 'test.txt', mimeType: 'text/plain', bytes: Buffer.from('test'), managed: true });
  try {
    const removedId = randomUUID();
    const removed = await upload(removedId);
    assert.ok('attachments' in removed);
    const removedPath = removed.attachments![0].path;
    assert.equal(await cancelAttachmentUpload(1, removedId), true);
    await assert.rejects(fs.stat(removedPath));
    await assert.rejects(upload(removedId), /cancelled/);
    const earlyCancelled = randomUUID();
    await cancelAttachmentUpload(1, earlyCancelled);
    await assert.rejects(upload(earlyCancelled), /cancelled/);

    const expiring = await upload(randomUUID());
    const retainedId = randomUUID();
    const retained = await upload(retainedId);
    assert.ok('attachments' in expiring && 'attachments' in retained);
    await assert.rejects(retainAttachmentUploads(retained.attachments!, 2), /another user/);
    await retainAttachmentUploads(retained.attachments!, 1);
    await expireUnsentAttachments(Date.now() + 3_500_000);
    await fs.stat(expiring.attachments![0].path);
    await expireUnsentAttachments(Date.now() + 3_600_001);
    await assert.rejects(fs.stat(expiring.attachments![0].path));
    assert.equal((await fs.readFile(retained.attachments![0].path, 'utf8')), 'test');
    assert.equal(await cancelAttachmentUpload(1, retainedId), false, 'a stale browser cannot delete a sent attachment');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
