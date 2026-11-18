import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import type { query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { queryClaudeControl } from '@/modules/providers/services/claude-control-query.service.js';

for (const outcome of ['success', 'failure', 'timeout', 'startup-failure'] as const) {
  test(`model metadata ${outcome} closes the CLI and never sends a user message or persists a session`, async () => {
    let cwd = '';
    let closed = false;
    let input: AsyncIterable<SDKUserMessage> | undefined;
    const createQuery = ((args: Parameters<typeof query>[0]) => {
      cwd = args.options!.cwd!;
      input = args.prompt as AsyncIterable<SDKUserMessage>;
      assert.equal(args.options!.persistSession, false);
      assert.deepEqual(args.options!.settingSources, ['user']);
      assert.deepEqual(args.options!.settings, { disableAllHooks: true });
      assert.deepEqual(args.options!.tools, []);
      assert.equal(args.options!.strictMcpConfig, true);
      if (outcome === 'startup-failure') throw new Error('startup failure');
      return {
        close: () => { closed = true; },
        supportedModels: async () => {
          await access(cwd);
          if (outcome === 'failure') throw new Error('query failure');
          if (outcome === 'timeout') return new Promise(() => {});
          return [{ value: 'cli-model', displayName: 'CLI model', description: '' }];
        },
      };
    }) as typeof query;
    const pending = queryClaudeControl((instance) => instance.supportedModels(), { createQuery, timeoutMs: 30 });
    if (outcome === 'success') assert.equal((await pending)[0].value, 'cli-model');
    else await assert.rejects(pending, outcome === 'timeout' ? /timed out/ : /failure/);
    assert.equal(closed, outcome !== 'startup-failure');
    await assert.rejects(access(cwd), { code: 'ENOENT' });
    const messages = [];
    for await (const message of input!) messages.push(message);
    assert.deepEqual(messages, []);
  });
}
