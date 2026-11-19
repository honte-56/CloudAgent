import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveCodexExecutablePath } from '@/shared/index.js';

async function withCliPaths(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'external-codex-'));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

const name = process.platform === 'win32' ? 'codex.exe' : 'codex';

test('resolves an external PATH command and skips npm-injected project binaries', async () => {
  await withCliPaths(async (root) => {
    const local = path.join(root, 'node_modules', '.bin');
    const global = path.join(root, 'external bin');
    await mkdir(local, { recursive: true });
    await mkdir(global);
    await writeFile(path.join(local, name), '', { mode: 0o755 });
    await writeFile(path.join(global, name), '', { mode: 0o755 });
    assert.equal(resolveCodexExecutablePath({ PATH: [local, global].join(path.delimiter) }), path.join(global, name));
    assert.throws(() => resolveCodexExecutablePath({ PATH: local }), /Install Codex separately/);
  });
});

test('an explicit executable wins, and an invalid override never falls back to PATH', async () => {
  await withCliPaths(async (root) => {
    const explicit = path.join(root, 'custom-cli');
    await writeFile(explicit, '', { mode: 0o755 });
    await writeFile(path.join(root, name), '', { mode: 0o755 });
    assert.equal(resolveCodexExecutablePath({ PATH: root, CLOUDCLI_CODEX_PATH: ` ${explicit} ` }), explicit);
    assert.throws(() => resolveCodexExecutablePath({ PATH: root, CLOUDCLI_CODEX_PATH: path.join(root, 'missing') }), /CODEX|Codex/);
  });
});

test('no external installation is reported missing even when the SDK is present', () => {
  assert.throws(() => resolveCodexExecutablePath({ PATH: '' }), /Install Codex separately/);
});

test('keeps the visible symlink so independently installed updates are picked up on the next run', { skip: process.platform === 'win32' }, async () => {
  await withCliPaths(async (root) => {
    const binary = path.join(root, 'codex-v-next');
    await writeFile(binary, '', { mode: 0o755 });
    await symlink(binary, path.join(root, name));
    assert.equal(resolveCodexExecutablePath({ PATH: root }), path.join(root, name));
  });
});
