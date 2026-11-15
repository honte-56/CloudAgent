import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import {
  buildSessionMessagesUrl,
  findLatestPageOverlapLength,
  mergeLatestServerPage,
  mergeOlderServerPage,
} from '@/modules/chat/utils/sessionMessagePagination';

function message(
  number: number,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  return {
    id: `m${number}`,
    sessionId: 'session-1',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, number)).toISOString(),
    provider: 'claude',
    kind: 'text',
    role: number % 2 === 0 ? 'assistant' : 'user',
    content: `message ${number}`,
    ...overrides,
  };
}

function range(start: number, end: number): NormalizedMessage[] {
  return Array.from({ length: end - start + 1 }, (_, index) => message(start + index));
}

test('automatic latest-history URL is explicitly bounded to the newest page', () => {
  assert.equal(
    buildSessionMessagesUrl('session/1', { limit: 20, offset: 0 }),
    '/api/providers/sessions/session%2F1/messages?limit=20&offset=0',
  );
});

test('overlapping latest page retains loaded older messages and replaces the tail', () => {
  const cached = range(21, 40);
  const latest = range(31, 50);
  latest[0] = { ...latest[0], content: 'fresh persisted value' };

  const result = mergeLatestServerPage(cached, latest);

  assert.equal(result.overlapLength, 10);
  assert.deepEqual(result.messages.map((item) => item.id), range(21, 50).map((item) => item.id));
  assert.equal(result.messages[10].content, 'fresh persisted value');
  assert.equal(new Set(result.messages.map((item) => item.id)).size, result.messages.length);
});

test('Codex rows with regenerated IDs overlap by stable transcript fields', () => {
  const cached = range(1, 20).map((item) => ({
    ...item,
    id: `codex-old-${item.id}`,
    provider: 'codex' as const,
  }));
  const latest = range(11, 30).map((item) => ({
    ...item,
    id: `codex-new-${item.id}`,
    provider: 'codex' as const,
  }));

  assert.equal(findLatestPageOverlapLength(cached, latest), 10);
  const merged = mergeLatestServerPage(cached, latest);
  assert.equal(merged.messages.length, 30);
  assert.deepEqual(
    merged.messages.slice(0, 10).map((item) => item.id),
    cached.slice(0, 10).map((item) => item.id),
  );
});

test('older-page reconciliation removes overlap caused by tail growth', () => {
  const cached = range(81, 100);
  const shiftedOlderPage = range(66, 85);
  const result = mergeOlderServerPage(cached, shiftedOlderPage);

  assert.equal(result.overlapLength, 5);
  assert.equal(result.prependedCount, 15);
  assert.deepEqual(result.messages.map((item) => item.id), range(66, 100).map((item) => item.id));
  assert.equal(new Set(result.messages.map((item) => item.id)).size, result.messages.length);
});

test('normal non-overlapping older pages prepend unchanged', () => {
  const cached = range(81, 100);
  const older = range(61, 80);
  const result = mergeOlderServerPage(cached, older);

  assert.equal(result.overlapLength, 0);
  assert.equal(result.prependedCount, 20);
  assert.deepEqual(result.messages.map((item) => item.id), range(61, 100).map((item) => item.id));
});

test('native message keys preserve overlap when a provider enriches the row', () => {
  const cached = [message(1, { messageKey: 'block:1' })];
  const updated = message(2, { messageKey: 'block:1', content: 'Completed reply' });
  const result = mergeLatestServerPage(cached, [updated]);
  assert.equal(result.overlapLength, 1);
  assert.deepEqual(result.messages, [updated]);
});

test('distinct native blocks with identical text and timestamps do not overlap', () => {
  const first = message(1, { messageKey: 'block:1' });
  const second = { ...first, id: 'second', messageKey: 'block:2' };
  assert.equal(findLatestPageOverlapLength([first], [second]), 0);
});

test('a disjoint fetched window is never concatenated onto cached history', () => {
  const cached = range(1, 20);
  const disjoint = range(30, 49);
  const merged = mergeLatestServerPage(cached, disjoint);

  assert.equal(merged.overlapLength, 0);
  assert.equal(merged.messages, cached);
});
