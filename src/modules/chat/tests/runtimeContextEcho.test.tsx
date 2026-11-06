import { readFileSync } from 'node:fs';
import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { stripRuntimeInstructions } from '@/shared/utils';
import type { NormalizedMessage } from '@/shared/types';
const state = vi.hoisted(() => ({ rows: [] as NormalizedMessage[] }));
vi.mock('@/shared/api', () => ({ api: { providers: { sessionMessages: async () => ({ ok: true, json: async () => ({ data: { messages: state.rows, hasMore: false, total: state.rows.length } }) }) } } }));
const instruction = 'This project has GitHub authentication configured for git over HTTPS and gh. Use git and gh directly; do not log in, read, print, or copy credentials. GitHub SSH remotes are mapped to HTTPS for this run. Commit and push only as requested by the user. Git author identity comes from the existing Git configuration.';
const text = '看看这些日志里还有哪些问题';
const file = { name: 'logs.jsonl', path: '/home/user/.cloudcli/assets/logs.jsonl' };
const local: NormalizedMessage = { id: 'local_upload', sessionId: 's', provider: 'claude', kind: 'text', role: 'user', timestamp: '2026-11-06T07:22:52Z', content: text, files: [{ ...file, size: 160000 }] };
const native = { ...local, id: 'native-user', timestamp: '2026-11-06T07:22:54Z', content: `${instruction}\n\n${text}`, files: [file] };

for (const provider of ['claude', 'codex'] as const) for (const serverFirst of [false, true]) test(`${provider} first prompt plus upload reconciles with the decorated native prompt (${serverFirst})`, async () => {
  state.rows = [{ ...native, provider }];
  const view = renderHook(useSessionStore);
  if (serverFirst) await act(async () => { await view.result.current.fetchFromServer('s'); });
  act(() => view.result.current.appendRealtime('s', { ...local, provider }));
  await act(async () => { await view.result.current.fetchFromServer('s'); });
  const rows = view.result.current.getMessages('s');
  expect(rows).toHaveLength(1);
  expect(rows[0].content).toBe(text);
  expect(rows[0].files).toHaveLength(1);
});

test('a live provider echo strips runtime metadata but local and already-cleaned quotations stay intact', () => {
  const view = renderHook(useSessionStore);
  act(() => view.result.current.appendRealtime('s', { ...native, content: `<cloudcli_runtime_context>\nInstructions\n</cloudcli_runtime_context>\n\n${text}` }));
  expect(view.result.current.getMessages('s')[0].content).toBe(text);
  act(() => view.result.current.appendRealtime('quotes', { ...local, content: native.content }));
  expect(view.result.current.getMessages('quotes')[0].content).toBe(native.content);
  act(() => view.result.current.appendRealtime('cleaned', { ...native, runtimeContextStripped: true }));
  expect(view.result.current.getMessages('cleaned')[0].content).toBe(native.content);
  expect(stripRuntimeInstructions(`Explain this:\n${instruction}\n\ntext`)).toContain(instruction);
});

const path = process.env.CLOUDCLI_USER_CONTEXT_FIXTURE;
const fixture = path ? JSON.parse(readFileSync(path, 'utf8')) : null;
for (const version of ['old', 'new']) test.skipIf(!fixture)(`actual JSONL attachment prompt appears once with ${version} backend`, async () => {
  state.rows = fixture[version];
  const view = renderHook(useSessionStore);
  act(() => view.result.current.appendRealtime('s', fixture.local));
  await act(async () => { await view.result.current.fetchFromServer('s'); });
  const rows = view.result.current.getMessages('s');
  expect(rows).toHaveLength(1);
  expect(rows[0].content).toBe(fixture.local.content);
  expect(rows[0].files).toHaveLength(1);
  expect(rows[0].files?.[0].name).toBe('logs-2026-11-06.jsonl');
});
