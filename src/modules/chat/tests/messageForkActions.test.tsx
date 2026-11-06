import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import '@/modules/i18n';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import type { ChatMessage } from '@/shared/types';
afterEach(cleanup);

function row(message: ChatMessage, onFork = vi.fn()) {
  return render(<UiPreferencesProvider><MessageComponent message={message} prevMessage={null} createDiff={() => []} provider="codex" onForkFromMessage={onFork} /></UiPreferencesProvider>);
}
for (const type of ['user', 'assistant']) test(`${type} exposes a visible fork action and blocks duplicate clicks while creating`, async () => {
  let finish!: () => void;
  const fork = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  row({ type, content: 'A complete turn', timestamp: '2026-11-03T12:00:00Z', forkAnchorId: 'turn-one' }, fork);
  const button = screen.getByRole('button', { name: /Fork through this completed turn/ });
  expect(button.className).not.toContain('opacity-0');
  fireEvent.click(button);
  fireEvent.click(screen.getByRole('button', { name: /Creating branch/ }));
  expect(fork).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
});
test('an attachment-only prompt also offers a branch action', () => {
  row({ type: 'user', content: '', timestamp: '2026-11-03T12:00:00Z', forkAnchorId: 'turn-one', files: [{ path: '/tmp/doc.txt', name: 'doc.txt' }] });
  expect(screen.getByRole('button', { name: /Fork through this completed turn/ })).toBeTruthy();
});
test('a streaming or not-yet-indexed message keeps a disabled action with an explanation', () => {
  const fork = vi.fn();
  row({ type: 'assistant', content: 'Still working', timestamp: '2026-11-03T12:00:00Z' }, fork);
  const button = screen.getByRole('button', { name: /Waiting for the reply/ }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(fork).not.toHaveBeenCalled();
});
test('the fork boundary survives message conversion independently of the edit anchor', () => {
  const [message] = normalizedToChatMessages([{ id: 'row', sessionId: 'session', timestamp: '2026-11-03T12:00:00Z', provider: 'claude', kind: 'text', role: 'user', content: 'Prompt', transcriptAnchorId: 'prompt', forkAnchorId: 'answer' }]);
  expect(message.transcriptAnchorId).toBe('prompt');
  expect(message.forkAnchorId).toBe('answer');
});
