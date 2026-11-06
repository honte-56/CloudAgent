import { readFileSync } from 'node:fs';
import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage } from '@/shared/types';

const mock = vi.hoisted(() => ({ messages: [] as NormalizedMessage[] }));
vi.mock('@/shared/api', () => ({ api: { providers: { sessionMessages: async () => ({ ok: true, json: async () => ({ data: { messages: mock.messages, total: mock.messages.length, hasMore: false } }) }) } } }));
const row = (id: string, kind: NormalizedMessage['kind'], content: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage => ({ id, messageKey: id, kind, content, sessionId: 's', provider: 'claude', timestamp: '2026-11-05T09:43:40.000Z', ...extra });

for (const historyFirst of [true, false]) test(`split Claude block offsets cannot duplicate an answer before its question (history first: ${historyFirst})`, async () => {
  const previous = row('claude:previous:0', 'text', 'Previous reply', { role: 'assistant' });
  const question = row('question', 'text', 'When does packaging start?', { role: 'user' });
  const answer = row('claude:response:0', 'text', 'It starts after release.', { role: 'assistant' });
  mock.messages = [previous, question, answer];
  const view = renderHook(useSessionStore);
  if (historyFirst) await act(async () => { await view.result.current.fetchFromServer('s'); });
  act(() => {
    view.result.current.appendRealtime('s', { ...previous, seq: 10 });
    view.result.current.appendRealtime('s', row('claude:response:1', 'stream_delta', answer.content!, { seq: 20, firstSeq: 12 }));
    view.result.current.appendRealtime('s', { ...answer, seq: 21 });
    view.result.current.finalizeStreaming('s');
  });
  await act(async () => { await view.result.current.fetchFromServer('s'); });
  expect(view.result.current.getMessages('s').map(r => r.id)).toEqual(mock.messages.map(r => r.id));
});

test('legacy block identities reconcile only within one API response, preserving identical answers in later turns', async () => {
  mock.messages = [row('q1', 'text', 'One', { role: 'user' }), row('claude:a:1', 'text', 'Done', { role: 'assistant' }), row('q2', 'text', 'Two', { role: 'user' }), row('claude:b:1', 'text', 'Done', { role: 'assistant' })];
  const view = renderHook(useSessionStore);
  await act(async () => { await view.result.current.fetchFromServer('s'); });
  act(() => {
    view.result.current.appendRealtime('s', row('claude:a:0', 'text', 'Done', { role: 'assistant', seq: 1 }));
    view.result.current.appendRealtime('s', row('claude:b:0', 'text', 'Done', { role: 'assistant', seq: 2 }));
  });
  expect(view.result.current.getMessages('s').filter(r => r.role === 'assistant')).toHaveLength(2);
});

test('partial stream alias can grow but cannot overwrite a different block or response', async () => {
  mock.messages = [row('q', 'text', 'Question', { role: 'user' }), row('claude:a:1', 'text', 'First block', { role: 'assistant' }), row('claude:a:2', 'text', 'Second block', { role: 'assistant' })];
  const view = renderHook(useSessionStore);
  await act(async () => { await view.result.current.fetchFromServer('s'); });
  act(() => {
    view.result.current.appendRealtime('s', row('claude:a:0', 'stream_delta', 'First block extended', { seq: 1 }));
    view.result.current.appendRealtime('s', row('claude:other:0', 'stream_delta', 'First block', { seq: 2 }));
  });
  const rows = view.result.current.getMessages('s');
  expect(rows.find(r => r.id === 'claude:a:1')?.content).toBe('First block extended');
  expect(rows.find(r => r.id === 'claude:a:2')?.content).toBe('Second block');
  expect(rows.find(r => r.id === 'claude:other:0')).toBeTruthy();
});

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

test('a live legacy completion consumes its stream alias before any history refresh or finalize', () => {
  mock.messages = [];
  const view = renderHook(useSessionStore);
  act(() => {
    view.result.current.appendRealtime('s', row('claude:a:1', 'stream_delta', 'Answer', { seq: 9 }));
    view.result.current.appendRealtime('s', row('claude:a:0', 'text', 'Answer', { role: 'assistant', seq: 10 }));
  });
  expect(view.result.current.getMessages('s')).toHaveLength(1);
  act(() => view.result.current.finalizeStreaming('s'));
  expect(view.result.current.getMessages('s')).toHaveLength(1);
});

test.skipIf(!fixture)('real cached old history converges after the corrected backend is activated', async () => {
  mock.messages = fixture.oldHistory.messages;
  const view = renderHook(useSessionStore);
  await act(async () => { await view.result.current.fetchFromServer('s'); });
  act(() => {
    for (const event of fixture.events) if (['text', 'stream_delta', 'thinking', 'tool_use', 'tool_result'].includes(event.kind)) view.result.current.appendRealtime('s', event);
    view.result.current.finalizeStreaming('s');
  });
  expect(view.result.current.getMessages('s').filter(m => m.content?.startsWith('按 PR #868 的写法'))).toHaveLength(1);
  mock.messages = fixture.history.messages;
  await act(async () => { await view.result.current.refreshLatestFromServer('s'); });
  const rows = view.result.current.getMessages('s');
  const answers = rows.filter(m => m.content?.startsWith('按 PR #868 的写法'));
  expect(answers).toHaveLength(1);
  expect(rows.indexOf(answers[0])).toBeGreaterThan(rows.findIndex(m => m.role === 'user' && m.content === '打包在什么时候启动'));
});
