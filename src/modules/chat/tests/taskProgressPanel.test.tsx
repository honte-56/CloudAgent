import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import '@/modules/i18n';
import { TaskProgressPanel } from '@/modules/chat/transcript/TaskProgressPanel';
import { BackgroundTasksStrip } from '@/modules/chat/transcript/BackgroundTasksStrip';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { Project, TaskProgressSnapshot } from '@/shared/types';
const { progress } = vi.hoisted(() => ({ progress: vi.fn() }));
vi.mock('@/shared/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/shared/api')>();
  return { ...actual, api: { ...actual.api, providers: { ...actual.api.providers, taskProgress: progress } } };
});
const project = { projectId: 'project', displayName: 'Project', fullPath: '/workspace' } as Project;
function result(content: string): TaskProgressSnapshot {
  return { parentSessionId: 'parent', toolUseId: 'launch', provider: 'codex', title: 'Packager', kind: 'conversation', status: 'running', updatedAt: new Date().toISOString(), messages: [{ id: 'progress', kind: 'text', role: 'assistant', provider: 'codex', sessionId: 'child', content, timestamp: '2026-11-04T00:00:00Z' }] };
}
const response = (content: string) => ({ ok: true, json: async () => ({ data: result(content) }) });
beforeEach(() => { progress.mockReset(); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

test('task chips open the sidebar callback and keep stop separate from viewing', () => {
  const open = vi.fn(), reveal = vi.fn(), send = vi.fn();
  render(<BackgroundTasksStrip messages={[{ type: 'assistant', content: '', timestamp: new Date(), isToolUse: true, toolName: 'Bash', toolId: 'launch', taskStatus: { status: 'running', taskId: 'task', description: 'Packager' } }]}
    sessionId="parent" sendMessage={send} onReveal={reveal} onLoadAll={() => {}} onOpenTask={open} />);
  fireEvent.click(screen.getByRole('button', { name: /Command.*Packager/ }));
  expect(open).toHaveBeenCalledWith('launch', expect.stringContaining('Packager'));
  expect(reveal).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(send).toHaveBeenCalledWith({ type: 'chat.stop-task', sessionId: 'parent', taskId: 'task' });
  expect(open).toHaveBeenCalledTimes(1);
});

test('sidebar updates in place, retains the last snapshot during refresh, and stops fetching on close', async () => {
  let resolveRefresh!: (value: unknown) => void;
  progress.mockResolvedValueOnce(response('First progress')).mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));
  const close = vi.fn();
  const pathname = window.location.href;
  const view = render(<UiPreferencesProvider><TaskProgressPanel sessionId="parent" toolUseId="launch" title="Packager" selectedProject={project} createDiff={() => []} onClose={close} /></UiPreferencesProvider>);
  await act(async () => {});
  expect(screen.getByText('First progress')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  await act(async () => { vi.advanceTimersByTime(2000); });
  expect(screen.getByText('First progress')).toBeTruthy();
  expect((screen.getByRole('button', { name: '刷新子任务进展' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { resolveRefresh(response('Tests passed')); });
  expect(screen.getByText('Tests passed')).toBeTruthy();
  expect(window.location.href).toBe(pathname);
  fireEvent.click(screen.getByRole('button', { name: '关闭子任务侧栏' }));
  expect(close).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => { vi.advanceTimersByTime(6000); });
  expect(progress).toHaveBeenCalledTimes(2);
});

test('temporary failures keep the last progress visible and retry automatically', async () => {
  progress.mockResolvedValueOnce(response('Keep this progress')).mockRejectedValueOnce(new Error('Temporary disconnect')).mockResolvedValue(response('Recovered progress'));
  render(<UiPreferencesProvider><TaskProgressPanel sessionId="parent" toolUseId="launch" title="Task" selectedProject={project} createDiff={() => []} onClose={() => {}} /></UiPreferencesProvider>);
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(2000); });
  expect(screen.getByText('Keep this progress')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('Temporary disconnect');
  await act(async () => { vi.advanceTimersByTime(2000); });
  expect(screen.getByText('Recovered progress')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});
