import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { Project, SessionWithProvider } from '@/shared/types';
import SessionOptions from '@/modules/sidebar/SessionOptions';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set(['codex', 'claude']) }));
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => true }));
afterEach(cleanup);
const t = ((key: string) => key) as TFunction;
const noop = () => {};
const common = { sessionId: 'session', sessionName: 'Source', provider: 'codex' as const, projectId: 'project', isProcessing: true, isEditing: false, renameDraft: '', onRenameDraftChange: noop, onStartEditingSession: noop, onCancelEditingSession: noop, onSaveEditingSession: noop, onDeleteSession: noop, t };
test('desktop menu keeps the fork action available while the source is running', async () => {
  const fork = vi.fn(async () => {});
  render(<SessionOptions {...common} onFork={fork} />);
  fireEvent.click(screen.getByRole('button', { name: 'Session options for Source' }));
  await act(async () => { fireEvent.click(screen.getByText('buttons.forkSession')); });
  expect(fork).toHaveBeenCalledTimes(1);
});
test('mobile menu offers the same fork action and shows pending progress', async () => {
  let finish!: () => void;
  const fork = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<SidebarSessionItem project={{ projectId: 'project', displayName: 'Project', fullPath: '/repo' } as Project}
    session={{ id: 'session', summary: 'Source', __provider: 'codex' } as SessionWithProvider}
    selectedSession={null} isProcessing hasBackgroundWork={false} needsAttention={false} currentTime={new Date()}
    isEditing={false} renameDraft="" onRenameDraftChange={noop} onStartEditingSession={noop} onCancelEditingSession={noop} onSaveEditingSession={noop}
    onProjectSelect={noop} onSessionSelect={noop} onDeleteSession={noop} onForkSession={fork} isSelecting={false} isChecked={false} onToggleSessionSelected={noop} t={t} />);
  fireEvent.click(screen.getByRole('button', { name: 'Session options for Source' }));
  fireEvent.click(screen.getByText('buttons.forkSession'));
  const pending = screen.getByText('buttons.forkingSession').closest('button')!;
  expect(pending.disabled).toBe(true);
  fireEvent.click(pending);
  expect(fork).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
});
