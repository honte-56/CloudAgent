import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProviderPlanUsageService,
  parseClaudeUsageBody,
  parseCodexRateLimits,
} from '@/modules/providers/services/provider-plan-usage.service.js';

import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { AppError } from '@/shared/index.js';

const NOW = Date.parse('2026-10-30T00:00:00.000Z');

test('CLI windows use percentages and ISO timestamps, ignoring invalid and expired fields', () => {
  const windows = parseClaudeUsageBody({
    seven_day: { utilization: 120, resets_at: '2026-10-31T00:00:00Z' },
    five_hour: { utilization: 41.5, resets_at: '2026-10-30T01:00:00Z' },
    unrelated: { utilization: 5 },
  }, NOW);
  assert.deepEqual(windows.map(w => [w.id, w.usedPercent]), [['five_hour', 41.5], ['weekly', 100]]);
  assert.equal(windows[0].resetsAt, '2026-10-30T01:00:00.000Z');
  for (const entry of [null, {}, { utilization: null }, { utilization: '20', resets_at: '2026-10-30T00:00:01Z' },
    { utilization: 20, resets_at: new Date(NOW).toISOString() }, { utilization: 20, resets_at: 1e99 }]) {
    assert.deepEqual(parseClaudeUsageBody({ five_hour: entry }, NOW), []);
  }
});

test('parseCodexRateLimits reports an already-reset window as unused', () => {
  const result = parseCodexRateLimits({
    plan_type: 'pro',
    primary: { used_percent: 94, window_minutes: 10080, resets_at: Math.floor(NOW / 1000) - 60 },
    secondary: { used_percent: 10, window_minutes: 300, resets_at: Math.floor(NOW / 1000) + 600 },
    credits: { balance: '12.5', unlimited: false },
  }, '2026-10-29T00:00:00.000Z', NOW);

  assert.equal(result.planName, 'Pro');
  assert.deepEqual(result.windows.map((w) => [w.id, w.usedPercent]), [['weekly', 0], ['five_hour', 10]]);
  assert.equal(result.windows[0].resetsAt, null);
  assert.deepEqual(result.credits, { balance: '12.5', unlimited: false });
});

const usage = (used = 20) => ({
  subscription_type: 'pro', rate_limits_available: true,
  rate_limits: { five_hour: { utilization: used, resets_at: '2026-10-30T01:00:00Z' } },
}) as SDKControlGetUsageResponse;

test('Claude caches completed queries for five minutes and coalesces concurrent misses', async () => {
  let resolve!: (result: SDKControlGetUsageResponse) => void;
  let calls = 0;
  let now = NOW;
  const service = createProviderPlanUsageService({ now: () => now, queryClaudeUsage: () => {
    calls++;
    return new Promise(done => { resolve = done; });
  } });
  const first = service.getPlanUsage('claude');
  const second = service.getPlanUsage('claude');
  assert.equal(calls, 1);
  now += 2_000;
  resolve(usage());
  const result = await first;
  assert.deepEqual(result, await second);
  assert.equal(result.source, 'cli');
  assert.equal(result.status, 'ok');
  assert.equal(result.planName, 'Pro');
  assert.equal(result.fetchedAt, new Date(now).toISOString());
  assert.equal(result.windows[0].usedPercent, 20);
  now += 299_999;
  assert.deepEqual(await service.getPlanUsage('claude'), result);
  assert.equal(calls, 1);
  now += 1;
  const refresh = service.getPlanUsage('claude');
  const concurrentRefresh = service.getPlanUsage('claude');
  assert.equal(calls, 2);
  resolve(usage(25));
  const refreshed = await refresh;
  assert.equal(refreshed.windows[0].usedPercent, 25);
  assert.equal(refreshed.fetchedAt, new Date(now).toISOString());
  assert.deepEqual(await concurrentRefresh, refreshed);
});

test('manual refresh bypasses fresh cache, shares in-flight work and restarts cache lifetime', async () => {
  let now = NOW;
  let calls = 0;
  let resolve!: (result: SDKControlGetUsageResponse) => void;
  const service = createProviderPlanUsageService({ now: () => now, queryClaudeUsage: () => {
    calls++;
    return new Promise(done => { resolve = done; });
  } });
  const initial = service.getPlanUsage('claude');
  resolve(usage());
  await initial;
  now += 60_000;
  const manual = service.getPlanUsage('claude', { forceRefresh: true });
  const duplicate = service.getPlanUsage('claude', { forceRefresh: true });
  const reopened = service.getPlanUsage('claude');
  assert.equal(calls, 2);
  resolve(usage(30));
  const fresh = await manual;
  assert.equal(fresh.windows[0].usedPercent, 30);
  assert.deepEqual(await duplicate, fresh);
  assert.deepEqual(await reopened, fresh);
  now += 299_999;
  assert.deepEqual(await service.getPlanUsage('claude'), fresh);
  assert.equal(calls, 2);
});

test('unavailable CLI limits are explicit, never fabricated zero usage', async () => {
  for (const response of [{ ...usage(), rate_limits_available: false }, { ...usage(), rate_limits: {} }]) {
    const service = createProviderPlanUsageService({ now: () => NOW, queryClaudeUsage: async () => response as SDKControlGetUsageResponse });
    const result = await service.getPlanUsage('claude');
    assert.equal(result.status, 'unsupported');
    assert.deepEqual(result.windows, []);
  }
});

test('CLI failure and timeout are sanitized and allow a later retry', async () => {
  for (const error of [new Error('secret stderr'), new AppError('timeout', { code: 'CLAUDE_USAGE_TIMEOUT', statusCode: 504 })]) {
    let fail = true;
    const service = createProviderPlanUsageService({ now: () => NOW, queryClaudeUsage: async () => {
      if (fail) throw error;
      return usage();
    } });
    const result = await service.getPlanUsage('claude');
    assert.equal(result.status, error instanceof AppError ? 'timeout' : 'error');
    assert.equal(JSON.stringify(result).includes('secret'), false);
    fail = false;
    assert.equal((await service.getPlanUsage('claude')).status, 'ok');
  }
});

test('a failed live Codex query preserves the original log timestamp and identifies its fallback', async () => {
  const event = (used: number) => JSON.stringify({
    timestamp: '2026-10-29T10:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        plan_type: 'pro',
        primary: { used_percent: used, window_minutes: 10080, resets_at: Math.floor(NOW / 1000) + 86_400 },
        secondary: null,
      },
    },
  });
  const dirent = (name: string, dir: boolean) => ({ name, isDirectory: () => dir }) as never;

  const service = createProviderPlanUsageService({
    now: () => NOW,
    queryCodexUsage: async () => { throw new Error('offline'); },
    getHomeDirectory: () => '/home/test',
    readDirectory: async (directory) => (
      directory.endsWith('sessions') ? [dirent('old.jsonl', false), dirent('new.jsonl', false)] : []
    ),
    statMtimeMs: async (file) => (file.endsWith('new.jsonl') ? 2 : 1),
    readTextFileTail: async (file) => ({
      content: file.endsWith('new.jsonl') ? `${event(30)}\n${event(55)}\nnot json` : event(1),
      isComplete: true,
    }),
  });

  const result = await service.getPlanUsage('codex');
  assert.equal(result.status, 'ok');
  assert.equal(result.windows[0].usedPercent, 55);
  assert.equal(result.source, 'session-log');
  assert.equal(result.fetchedAt, '2026-10-29T10:00:00.000Z');
  assert.match(result.message!, /Live quota query failed/);
});

test('unknown providers are rejected and cursor is unsupported', async () => {
  const service = createProviderPlanUsageService();
  assert.equal((await service.getPlanUsage('cursor')).status, 'unsupported');
  await assert.rejects(() => service.getPlanUsage('nope'));
});


test('Codex manual refresh fetches live limits and timestamps completion, with five-minute cache and coalescing', async () => {
  let now = NOW;
  let calls = 0;
  let resolve!: (result: Record<string, unknown>) => void;
  const service = createProviderPlanUsageService({ now: () => now, queryCodexUsage: () => {
    calls++; return new Promise(done => { resolve = done; });
  } });
  const limits = { plan_type: 'pro', primary: { used_percent: 67, window_minutes: 10080, resets_at: NOW / 1000 + 86400 } };
  const initial = service.getPlanUsage('codex');
  resolve(limits);
  const first = await initial;
  assert.equal(first.source, 'cli');
  assert.equal(first.fetchedAt, new Date(NOW).toISOString());
  now += 60000;
  assert.deepEqual(await service.getPlanUsage('codex'), first);
  assert.equal(calls, 1);
  const manual = service.getPlanUsage('codex', { forceRefresh: true });
  const concurrent = service.getPlanUsage('codex', { forceRefresh: true });
  assert.equal(calls, 2);
  now += 1000;
  resolve(limits);
  const updated = await manual;
  assert.deepEqual(await concurrent, updated);
  assert.equal(updated.fetchedAt, new Date(now).toISOString());
  assert.notEqual(updated.fetchedAt, first.fetchedAt);
  now += 299999;
  assert.deepEqual(await service.getPlanUsage('codex'), updated);
  now++;
  const expired = service.getPlanUsage('codex');
  assert.equal(calls, 3);
  resolve(limits);
  await expired;
});
