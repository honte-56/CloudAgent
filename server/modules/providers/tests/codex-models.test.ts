import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexProviderModels } from '@/modules/providers/list/codex/codex-models.provider.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';

test('uses CLI model ids, names, defaults and effort metadata without a fixed model list', async () => {
  const adapter = new CodexProviderModels(async () => [
    { model: 'future-fast', displayName: 'Future fast', supportedReasoningEfforts: [] },
    { model: 'future-reasoner', displayName: 'Future reasoner', isDefault: true, description: 'From CLI',
      defaultReasoningEffort: 'new-effort', supportedReasoningEfforts: [{ reasoningEffort: 'new-effort', description: 'New tier' }] },
    { model: 'hidden-model', hidden: true, isDefault: true },
    { model: 'future-fast', displayName: 'Duplicate' },
    null,
  ]);
  const catalog = await adapter.getSupportedModels();
  assert.deepEqual(catalog.OPTIONS.map((model) => model.value), ['future-fast', 'future-reasoner']);
  assert.equal(catalog.DEFAULT, 'future-reasoner');
  assert.equal(catalog.OPTIONS[1].label, 'Future reasoner');
  assert.deepEqual(catalog.OPTIONS[1].effort, {
    default: 'new-effort', values: [{ value: 'new-effort', description: 'New tier' }],
  });
  assert.equal(catalog.OPTIONS[0].effort, undefined);
});

test('a new CLI list replaces old choices and uses the first visible model if no default is reported', async () => {
  let id = 'first';
  const adapter = new CodexProviderModels(async () => [{ model: id }]);
  assert.equal((await adapter.getSupportedModels()).DEFAULT, 'first');
  id = 'second';
  assert.deepEqual((await adapter.getSupportedModels()).OPTIONS.map((model) => model.value), ['second']);
});

test('CLI failures are propagated and empty responses never become a hardcoded catalog', async () => {
  await assert.rejects(new CodexProviderModels(async () => { throw new Error('offline'); }).getSupportedModels(), /offline/);
  assert.deepEqual(await new CodexProviderModels(async () => []).getSupportedModels(), { OPTIONS: [], DEFAULT: '' });
});

test('native model/list follows cursors and never starts a thread', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-model-rpc-'));
  const launcher = path.join(dir, 'codex.cjs');
  const previous = process.env.CLOUDCLI_CODEX_PATH;
  await writeFile(launcher, `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = {};
  else if (request.method === 'model/list' && request.params.includeHidden === false) {
    result = request.params.cursor === 'page-2'
      ? { data: [{ model: 'second' }], nextCursor: null }
      : { data: [{ model: 'first' }], nextCursor: 'page-2' };
  } else process.exit(1);
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
});
`, { mode: 0o755 });
  process.env.CLOUDCLI_CODEX_PATH = launcher;
  try {
    assert.deepEqual(await codexAppServer.listModels(), [{ model: 'first' }, { model: 'second' }]);
  } finally {
    if (previous === undefined) delete process.env.CLOUDCLI_CODEX_PATH;
    else process.env.CLOUDCLI_CODEX_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
