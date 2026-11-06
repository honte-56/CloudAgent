import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';

const history: NormalizedMessage[] = [
  { id: 'question', sessionId: 's1', provider: 'codex', timestamp: '2026-11-02T10:00:00Z', kind: 'text', role: 'user', content: 'Please fix this issue' },
  { id: 'answer', sessionId: 's1', provider: 'codex', timestamp: '2026-11-02T10:00:01Z', kind: 'text', role: 'assistant', content: 'I found the cause and am running tests' },
];
vi.mock('@/shared/api', () => ({ api: { providers: {
  sessionMessages: vi.fn(async () => ({ ok: true, json: async () => ({ data: { messages: history, total: 49, hasMore: true } }) })),
  sessionTokenUsage: vi.fn(async () => ({ ok: false })),
} } }));
const project: Project = { projectId: 'p1', displayName: 'Project', fullPath: '/workspace' };
const session = { id: 's1', __provider: 'codex' } as ProjectSession;
const noSend = () => true;
const statusRef = { current: new Map() }, seqRef = { current: new Map() };
function useTranscript() {
  const store = useSessionStore();
  const state = useChatSessionState({ isActive: true, selectedProject: project, selectedSession: session, ws: null, sendMessage: noSend,  statusCheckSentAtRef: statusRef, lastSeqRef: seqRef, sessionStore: store });
  return { store, state };
}
function tool(id: string, sequence: number): NormalizedMessage {
  return { id, toolId: id, kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'run tests' }, sessionId: 's1', provider: 'codex', timestamp: new Date(Date.UTC(2026, 10, 2, 10, 1, sequence)).toISOString() };
}
afterEach(cleanup);

test('hundreds of output snapshots update one command instead of creating hundreds of Bash rows', async () => {
  const view = renderHook(useTranscript);
  await waitFor(() => expect(view.result.current.state.chatMessages.length).toBe(2));
  act(() => {
    for (let i = 0; i < 150; i++) {
      view.result.current.store.appendRealtime('s1', tool('command-1', i));
      view.result.current.store.appendRealtime('s1', { ...tool('command-1-result', i), toolId: 'command-1', kind: 'tool_result', content: `output snapshot ${i}` });
    }
  });
  const rows = view.result.current.store.getMessages('s1');
  expect(rows).toHaveLength(4);
  expect(rows.find(row => row.id === 'command-1')?.timestamp).toBe(tool('command-1', 0).timestamp);
  const chat = normalizedToChatMessages(rows);
  expect(chat.filter(row => row.isToolUse)).toHaveLength(1);
  expect(JSON.stringify(chat)).toContain('output snapshot 149');
  expect(view.result.current.state.visibleMessages.some(row => row.content === history[0].content)).toBe(true);
});

test('more than 100 distinct commands keep already loaded user and assistant messages available', async () => {
  const view = renderHook(useTranscript);
  await waitFor(() => expect(view.result.current.state.chatMessages.length).toBe(2));
  act(() => {
    for (let i = 0; i < 120; i++) view.result.current.store.appendRealtime('s1', tool(`command-${i}`, i));
  });
  expect(view.result.current.state.chatMessages).toHaveLength(122);
  expect(view.result.current.state.visibleMessages).toHaveLength(122);
  expect(view.result.current.state.visibleMessages.some(row => row.content === history[1].content)).toBe(true);
});

test('an acknowledged supplemental message appears immediately and its later native echo stays one row', async () => {
  const view = renderHook(useTranscript);
  await waitFor(() => expect(view.result.current.state.chatMessages.length).toBe(2));
  const message: NormalizedMessage = { id: 'confirmed-native-input', sessionId: 's1', provider: 'codex',
    kind: 'text', role: 'user', content: 'Add this requirement', timestamp: new Date().toISOString() };
  act(() => view.result.current.store.appendRealtime('s1', message));
  expect(view.result.current.state.chatMessages.some(row => row.content === 'Add this requirement')).toBe(true);
  act(() => view.result.current.store.appendRealtime('s1', { ...message, timestamp: new Date(Date.now() + 1000).toISOString() }));
  expect(view.result.current.state.chatMessages.filter(row => row.content === 'Add this requirement')).toHaveLength(1);
});
