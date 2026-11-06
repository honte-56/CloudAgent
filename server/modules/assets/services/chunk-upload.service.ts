import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { buildStoredAttachmentRecords, ensureImageAssetsDir } from '@/modules/assets/services/image-assets.service.js';

const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const locks = new Map<string, Promise<void>>();
let nextCleanupAt = 0;

async function cleanExpiredUploads(root: string) {
  if (Date.now() < nextCleanupAt) return;
  nextCleanupAt = Date.now() + 60 * 60 * 1000;
  for (const name of await fs.readdir(root)) {
    if (!/^\d+-[\da-f-]{36}$/i.test(name) || locks.has(name)) continue;
    const folder = path.join(root, name);
    const metadata = await fs.readFile(path.join(folder, 'metadata.json'), 'utf8').then(JSON.parse, () => null);
    if (metadata?.managed) continue;
    const stat = await fs.stat(folder);
    if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) await fs.rm(folder, { recursive: true, force: true });
  }
}

/** Used by assets routes to store bounded chunks and assemble a retriable, user-owned attachment. */
export async function storeAttachmentChunk(input: {
  userId: number; uploadId: string; index: number; totalSize: number;
  name: string; mimeType: string; bytes: Buffer; managed?: boolean;
}) {
  const { userId, uploadId, index, totalSize, name, mimeType, bytes } = input;
  const count = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));
  if (!Number.isSafeInteger(userId) || userId <= 0
    || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(uploadId)
    || !Number.isSafeInteger(totalSize) || totalSize < 0 || totalSize > MAX_FILE_SIZE
    || !Number.isSafeInteger(index) || index < 0 || index >= count
    || !name || name.length > 255 || mimeType.length > 255
    || bytes.length !== Math.min(CHUNK_SIZE, totalSize - index * CHUNK_SIZE)) {
    throw new Error('Invalid upload chunk (maximum file size: 100MB).');
  }
  const key = `${userId}-${uploadId}`;
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const lock = new Promise<void>(resolve => { release = resolve; });
  locks.set(key, lock);
  await previous;
  try {
    const assets = await ensureImageAssetsDir();
    const root = path.join(assets, '.uploads');
    const folder = path.join(root, key);
    await fs.mkdir(folder, { recursive: true });
    await cleanExpiredUploads(root);
    if (await fs.stat(path.join(folder, '.cancelled')).then(() => true, () => false)) throw new Error('Upload was cancelled.');
    await fs.utimes(folder, new Date(), new Date());
    const metadataPath = path.join(folder, 'metadata.json');
    const identity = JSON.stringify({ name, mimeType, totalSize });
    let metadata: { identity: string; storedName: string; managed?: boolean; createdAt?: number; completedAt?: number; retained?: boolean };
    try {
      metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      metadata = { identity, storedName: `${Date.now()}-${input.managed ? `u${userId}-${uploadId}` : randomUUID()}-${name.replace(/[^a-zA-Z0-9.-]/g, '_').slice(-120)}`, ...(input.managed ? { managed: true, createdAt: Date.now() } : {}) };
      await fs.writeFile(metadataPath, JSON.stringify(metadata));
    }
    if (metadata.identity !== identity) throw new Error('Upload identity changed. Select the file again.');
    const destination = path.join(assets, metadata.storedName);
    const result = () => ({ attachments: buildStoredAttachmentRecords([{
      originalname: name, filename: metadata.storedName, size: totalSize, mimetype: mimeType,
    }]) });
    // A lost final response (or restart after the rename) must not duplicate a file.
    if (await fs.stat(destination).then(() => true, () => false)) return result();
    await fs.writeFile(path.join(folder, `${index}.chunk`), bytes);
    for (let part = 0; part < count; part++) {
      if (!await fs.stat(path.join(folder, `${part}.chunk`)).then(() => true, () => false)) {
        return { pending: true };
      }
    }
    const assembled = path.join(folder, 'assembled.partial');
    for (let part = 0; part < count; part++) {
      await pipeline(createReadStream(path.join(folder, `${part}.chunk`)), createWriteStream(assembled, { flags: part === 0 ? 'w' : 'a' }));
    }
    await fs.rename(assembled, destination);
    if (metadata.managed) { metadata.completedAt = Date.now(); await fs.writeFile(metadataPath, JSON.stringify(metadata)); }
    await Promise.all(Array.from({ length: count }, (_, part) => fs.unlink(path.join(folder, `${part}.chunk`))));
    return result();
  } finally {
    release();
    if (locks.get(key) === lock) locks.delete(key);
  }
}


async function exclusively<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const lock = new Promise<void>(resolve => { release = resolve; });
  locks.set(key, lock);
  await previous;
  try { return await operation(); }
  finally { release(); if (locks.get(key) === lock) locks.delete(key); }
}

/** Assets DELETE uses a cancellation tombstone so an in-flight final chunk cannot resurrect a removed attachment. */
export async function cancelAttachmentUpload(userId: number, uploadId: string): Promise<boolean> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(uploadId)) throw new Error('Invalid upload identity');
  const key = `${userId}-${uploadId}`;
  return exclusively(key, async () => {
    const assets = await ensureImageAssetsDir();
    const folder = path.join(assets, '.uploads', key);
    await fs.mkdir(folder, { recursive: true });
    const metadata = await fs.readFile(path.join(folder, 'metadata.json'), 'utf8').then(JSON.parse, () => null);
    if (metadata?.retained) return false;
    await fs.writeFile(path.join(folder, '.cancelled'), '');
    if (metadata?.storedName && path.basename(metadata.storedName) === metadata.storedName) {
      await fs.rm(path.join(assets, metadata.storedName), { force: true });
    }
    for (const entry of await fs.readdir(folder)) if (entry !== '.cancelled') await fs.rm(path.join(folder, entry), { force: true });
    return true;
  });
}

/** Chat admission and native queue admission call this before handing file paths to a CLI, preventing expiry during execution. */
export async function retainAttachmentUploads(attachments: Array<{ path: string }>, userId: number): Promise<void> {
  if (attachments.length === 0) return;
  const assets = await ensureImageAssetsDir();
  for (const attachment of attachments) {
    const filename = path.basename(attachment.path);
    const match = /^\d+-u(\d+)-([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})-/.exec(filename);
    if (!match) continue; // Existing, already-sent attachments have no upload lease.
    if (Number(match[1]) !== userId || path.resolve(attachment.path) !== path.join(assets, filename)) throw new Error('Attachment belongs to another user');
    const key = `${userId}-${match[2]}`;
    await exclusively(key, async () => {
      const folder = path.join(assets, '.uploads', key);
      const metadataPath = path.join(folder, 'metadata.json');
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      if (metadata.storedName !== filename || !metadata.completedAt || !await fs.stat(attachment.path).then(() => true, () => false)) throw new Error('Attachment upload has expired or was cancelled. Select the file again.');
      metadata.retained = true;
      await fs.writeFile(metadataPath, JSON.stringify(metadata));
    });
  }
}

/** Timer and tests expire only newly managed, unsent uploads; existing conversation assets are never age-deleted. */
export async function expireUnsentAttachments(now = Date.now()): Promise<void> {
  const root = path.join(await ensureImageAssetsDir(), '.uploads');
  const names = await fs.readdir(root).catch(() => []);
  for (const key of names) {
    if (!/^\d+-[\da-f-]{36}$/i.test(key) || locks.has(key)) continue;
    await exclusively(key, async () => {
      const folder = path.join(root, key);
      const metadata = await fs.readFile(path.join(folder, 'metadata.json'), 'utf8').then(JSON.parse, () => null);
      if (!metadata?.managed || metadata.retained || now - (metadata.completedAt ?? metadata.createdAt) < 3_600_000) return;
      if (metadata.storedName && path.basename(metadata.storedName) === metadata.storedName) await fs.rm(path.join(root, '..', metadata.storedName), { force: true });
      await fs.rm(folder, { recursive: true, force: true });
    });
  }
}

/** The assets router starts one unreferenced timer so cleanup runs even when no new files are uploaded. */
export function startAttachmentExpiry(): void {
  if (expiryTimer) return;
  expiryTimer = setInterval(() => { void expireUnsentAttachments().catch(error => console.error('Attachment expiry failed:', error.message)); }, 60_000);
  expiryTimer.unref();
}
let expiryTimer: ReturnType<typeof setInterval> | undefined;
