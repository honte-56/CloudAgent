import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import type { query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { queryClaudePlanUsage } from '@/modules/providers/services/claude-plan-query.service.js';

for (const outcome of ['success', 'failure', 'timeout', 'startup-failure'] as const) {
  test(`CLI usage ${outcome} cleans up without sending a user prompt`, async () => {
    let cwd = '';
    let closed = false;
    let input: AsyncIterable<SDKUserMessage> | undefined;
    const createQuery = ((args: Parameters<typeof query>[0]) => {
      cwd = args.options!.cwd!;
      input = args.prompt as AsyncIterable<SDKUserMessage>;
      assert.deepEqual(args.options!.tools, []);
      assert.deepEqual(args.options!.mcpServers, {});
      assert.equal(args.options!.strictMcpConfig, true);
      assert.equal(args.options!.persistSession, false);
      assert.deepEqual(args.options!.settings, { disableAllHooks: true });
      if (outcome === 'startup-failure') throw new Error('startup failure');
      return {
        close: () => { closed = true; },
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (options: unknown) => {
          assert.deepEqual(options, { skipBehaviors: true });
          await access(cwd);
          if (outcome === 'failure') throw new Error('query failure');
          if (outcome === 'timeout') return new Promise(() => {});
          return { rate_limits_available: true };
        },
      };
    }) as typeof query;
    const pending = queryClaudePlanUsage({ createQuery, timeoutMs: 30 });
    if (outcome === 'success') assert.equal((await pending).rate_limits_available, true);
    else await assert.rejects(pending, outcome === 'timeout' ? /timed out/ : /failure/);
    assert.equal(closed, outcome !== 'startup-failure');
    await assert.rejects(access(cwd), { code: 'ENOENT' });
    const messages = [];
    for await (const message of input!) messages.push(message);
    assert.deepEqual(messages, []);
  });
}
