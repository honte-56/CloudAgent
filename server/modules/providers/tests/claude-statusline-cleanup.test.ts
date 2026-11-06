import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeClaudeStatuslineCapture } from '@/modules/providers/services/claude-statusline-cleanup.service.js';

test('retires the capture hook while preserving user settings and any original command', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'statusline-cleanup-test-'));
  const file = path.join(directory, 'settings.json');
  try {
    await removeClaudeStatuslineCapture(directory);
    for (const original of ['', 'my-statusline --arg']) {
      await writeFile(file, JSON.stringify({ theme: 'dark', statusLine: {
        type: 'command', padding: 2,
        command: `node capture --cloudcli-statusline '/snapshot' '${Buffer.from(original).toString('base64')}'`,
      } }));
      await removeClaudeStatuslineCapture(directory);
      const settings = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(settings.theme, 'dark');
      if (original) assert.deepEqual(settings.statusLine, { type: 'command', padding: 2, command: original });
      else assert.equal(settings.statusLine, undefined);
      const cleaned = await readFile(file, 'utf8');
      await removeClaudeStatuslineCapture(directory);
      assert.equal(await readFile(file, 'utf8'), cleaned);
    }
    for (const text of ['{broken', JSON.stringify({ statusLine: { command: 'capture --cloudcli-statusline malformed' } })]) {
      await writeFile(file, text);
      await assert.rejects(removeClaudeStatuslineCapture(directory));
      assert.equal(await readFile(file, 'utf8'), text);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
