import { readFileSync } from 'node:fs';
import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage } from '@/shared/types';

const mock = vi.hoisted(() => ({ messages: [] as NormalizedMessage[] }));
vi.mock('@/shared/api', () => ({ api: { providers: { sessionMessages: async () => ({ ok: true, json: async () => ({ data: { messages: mock.messages, total: mock.messages.length, hasMore: false } }) }) } } }));
const row = (id: string, kind: NormalizedMessage['kind'], content: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage => ({ id, messageKey: id, kind, content, sessionId: 's', provider: 'claude', timestamp: '2026-11-05T09:43:40.000Z', ...extra });

const capturePath = process.env.CLOUDCLI_CLAUDE_BLOCK_FIXTURE;
const fixture = capturePath ? JSON.parse(readFileSync(capturePath, 'utf8')) : null;

for (const historyFirst of [true, false]) test.skipIf(!fixture)(`actual Claude packaging answer appears once, after its prompt (${historyFirst})`, async () => {
  mock.messages = fixture.history.messages;
  const view = renderHook(useSessionStore);
  if (historyFirst) await act(async () => { await view.result.current.fetchFromServer('s'); });
  const displayKinds = new Set(['text', 'stream_delta', 'thinking', 'tool_use', 'tool_result', 'task_status', 'task_notification']);
  act(() => {
    for (const event of fixture.events) if (displayKinds.has(event.kind)) view.result.current.appendRealtime('s', event);
    view.result.current.finalizeStreaming('s');
  });
  await act(async () => { await view.result.current.fetchFromServer('s'); });
  const messages = view.result.current.getMessages('s');
  const answers = messages.filter(m => m.content?.startsWith('按 PR #868 的写法'));
  expect(answers).toHaveLength(1);
  const question = messages.findIndex(m => m.role === 'user' && m.content === '打包在什么时候启动');
  expect(question).toBeGreaterThanOrEqual(0);
  expect(messages.indexOf(answers[0])).toBeGreaterThan(question);
});

test('corrected native block keys preserve identical text in separate blocks of the same response', async () => {
  mock.messages = [row('q', 'text', 'Question', { role: 'user' }), row('claude-block:a:1', 'text', 'Again', { role: 'assistant' })];
  const view = renderHook(useSessionStore);
  await act(async () => { await view.result.current.fetchFromServer('s'); });
  act(() => view.result.current.appendRealtime('s', row('claude-block:a:3', 'text', 'Again', { role: 'assistant', seq: 9 })));
  expect(view.result.current.getMessages('s').filter(r => r.role === 'assistant')).toHaveLength(2);
});
