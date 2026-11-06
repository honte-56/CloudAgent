import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import '@/modules/i18n';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';
import type { PendingPermissionRequest } from '@/shared/types';

afterEach(cleanup);
const request: PendingPermissionRequest = { requestId: 'codex-question-1', sessionId: 'app-session', toolName: 'AskUserQuestion',
  context: { provider: 'codex', isBlocking: false }, input: { questions: [{ id: '0', question: 'Which action should I take?', options: [
    { label: 'Keep existing content', description: '' }, { label: 'Stop and preserve evidence', description: '' },
  ] }] } };

test('Codex options render as selectable controls and return the chosen value under the native question ID', () => {
  const decide = vi.fn();
  render(<PermissionRequestsBanner pendingPermissionRequests={[request]} handlePermissionDecision={decide} handleGrantToolPermission={() => ({ success: false })} />);
  expect(decide).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: /^Submit/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /Stop and preserve evidence/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Submit/ }));
  expect(decide).toHaveBeenCalledWith('codex-question-1', expect.objectContaining({ allow: true,
    updatedInput: expect.objectContaining({ answers: { '0': 'Stop and preserve evidence' } }),
  }));
});

test('Codex free-text questions remain answerable when there are no suggested options', () => {
  const decide = vi.fn();
  const view = render(<PermissionRequestsBanner pendingPermissionRequests={[{ ...request, input: { questions: [{ id: 'free', question: 'Your answer?', options: [] }] } }]}
    handlePermissionDecision={decide} handleGrantToolPermission={() => ({ success: false })} />);
  fireEvent.click(screen.getByRole('button', { name: /Other/ }));
  fireEvent.change(view.container.querySelector('input')!, { target: { value: 'Wait for my review' } });
  fireEvent.click(screen.getByRole('button', { name: /^Submit/ }));
  expect(decide.mock.calls[0][1].updatedInput.answers).toEqual({ free: 'Wait for my review' });
});
