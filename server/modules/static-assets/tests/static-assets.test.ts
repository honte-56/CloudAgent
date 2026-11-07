import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import express from 'express';

import { createStaticAssetsRouter } from '../index.js';

test('production serves the generated worker; source-only development falls back to public', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cloudagent-static-'));
  await mkdir(path.join(root, 'public'));
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'public', 'sw.js'), 'const BUILD = null;');
  await writeFile(path.join(root, 'dist', 'sw.js'), 'const BUILD = { id: "production" };');
  const app = express();
  app.use(createStaticAssetsRouter(root));
  app.use(express.static(path.join(root, 'public')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const url = `http://127.0.0.1:${address.port}/sw.js`;
    const production = await fetch(url);
    assert.equal(production.status, 200);
    assert.equal(production.headers.get('cache-control'), 'no-cache');
    assert.match(production.headers.get('content-type') ?? '', /javascript/);
    assert.equal(await production.text(), 'const BUILD = { id: "production" };');

    await rm(path.join(root, 'dist', 'sw.js'));
    const development = await fetch(url);
    assert.equal(development.status, 200);
    assert.equal(await development.text(), 'const BUILD = null;');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
