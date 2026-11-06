import assert from 'node:assert/strict';
import test from 'node:test';
import { queryCodexPlanUsage } from '@/modules/providers/services/codex-plan-query.service.js';

test('Codex quota query only reads the account, maps live windows, and closes its client', async () => {
  const calls: string[] = [];
  const result = await queryCodexPlanUsage({ createClient: () => ({
    initialize: async () => { calls.push('initialize'); },
    call: async method => {
      calls.push(method);
      return { rateLimits: { primary: { usedPercent: 1 } }, rateLimitsByLimitId: { codex: {
        planType: 'pro', primary: { usedPercent: 67, windowDurationMins: 10080, resetsAt: 1793774209 },
        secondary: null, credits: { balance: '10', unlimited: false },
      } } };
    },
    close: () => { calls.push('close'); },
  }) });
  assert.deepEqual(calls, ['initialize', 'account/rateLimits/read', 'close']);
  assert.deepEqual(result, { plan_type: 'pro', primary: { used_percent: 67, window_minutes: 10080, resets_at: 1793774209 }, secondary: null, credits: { balance: '10', unlimited: false } });
});

test('a stalled Codex quota query times out and closes its process without starting a turn', async () => {
  let closed = false;
  await assert.rejects(queryCodexPlanUsage({ timeoutMs: 10, createClient: () => ({
    initialize: () => new Promise(() => {}),
    call: async () => { throw new Error('must not start a call before initialization'); },
    close: () => { closed = true; },
  }) }), /timed out/);
  assert.equal(closed, true);
});
