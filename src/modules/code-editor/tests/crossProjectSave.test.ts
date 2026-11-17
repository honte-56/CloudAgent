import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useCodeEditorDocument } from '@/modules/code-editor/hooks/useCodeEditorDocument';

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), projects: vi.fn() }));
vi.mock('@/shared/api', () => ({
  api: { readFile: mocks.read, saveFile: mocks.save, projects: mocks.projects },
  readApiJson: async (response: Response) => {
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response.json();
  },
}));

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const denied = () => json({ error: 'Path must be under project root' }, 403);
const file = { name: 'review.csv', path: '/workspace/BiliUploadAuto/exports/review.csv', projectId: 'conversation' };
const edited = '\uFEFFword,status\r\n贝拉,pending\r\n';

beforeEach(() => {
  mocks.read.mockReset().mockImplementation(async () => json({ content: 'word,status\r\n贝拉,active\r\n' }));
  mocks.save.mockReset().mockImplementation(async () => json({ success: true }));
  mocks.projects.mockReset().mockImplementation(async () => json([
    { projectId: 'conversation', fullPath: '/workspace/conversation' },
    { projectId: 'workspace', fullPath: '/workspace' },
    { projectId: 'bili', fullPath: '/workspace/BiliUploadAuto/' },
  ]));
});

test('saves the pending CSV under its registered owner without rereading or changing the buffer', async () => {
  mocks.save.mockResolvedValueOnce(denied());
  const { result } = renderHook(() => useCodeEditorDocument({ file }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.setContent(edited));
  await act(() => result.current.handleSave());
  expect(mocks.save.mock.calls).toEqual([
    ['conversation', file.path, edited], ['bili', file.path, edited],
  ]);
  expect(result.current.content).toBe(edited);
  expect(result.current.hasUnsavedChanges).toBe(false);
  expect(result.current.saveError).toBeNull();
  expect(mocks.read).toHaveBeenCalledTimes(1);
});

test('normal saves never fetch the project list', async () => {
  const { result } = renderHook(() => useCodeEditorDocument({ file }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(() => result.current.handleSave());
  expect(mocks.projects).not.toHaveBeenCalled();
  expect(mocks.save).toHaveBeenCalledTimes(1);
});

test.each(['Permission denied', 'Path must be under project root'])('keeps edits on failure and never retries under an unrelated root: %s', async message => {
  mocks.save.mockResolvedValueOnce(json({ error: message }, 403));
  mocks.projects.mockResolvedValueOnce(json([{ projectId: 'prefix', fullPath: '/workspace/Bili' }]));
  const { result } = renderHook(() => useCodeEditorDocument({ file }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.setContent(edited));
  await act(() => result.current.handleSave());
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(result.current.hasUnsavedChanges).toBe(true);
  expect(result.current.content).toBe(edited);
  expect(result.current.saveError).toBe(message);
  if (message === 'Permission denied') expect(mocks.projects).not.toHaveBeenCalled();
});

test('a retry failure retains the draft and reports the owning project error', async () => {
  mocks.save.mockResolvedValueOnce(denied()).mockResolvedValueOnce(json({ error: 'Permission denied' }, 403));
  const { result } = renderHook(() => useCodeEditorDocument({ file }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.setContent(edited));
  await act(() => result.current.handleSave());
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(result.current.content).toBe(edited);
  expect(result.current.hasUnsavedChanges).toBe(true);
  expect(result.current.saveError).toBe('Permission denied');
});

test('typing during project lookup keeps newer edits dirty after the original buffer is saved', async () => {
  mocks.save.mockResolvedValueOnce(denied());
  let resolveProjects!: (response: Response) => void;
  mocks.projects.mockImplementation(() => new Promise<Response>(resolve => { resolveProjects = resolve; }));
  const { result } = renderHook(() => useCodeEditorDocument({ file }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.setContent(edited));
  let saving!: Promise<void>;
  act(() => { saving = result.current.handleSave(); });
  await waitFor(() => expect(mocks.projects).toHaveBeenCalled());
  act(() => result.current.setContent(edited + 'new,active\r\n'));
  await act(async () => {
    resolveProjects(json([{ projectId: 'bili', fullPath: '/workspace/BiliUploadAuto' }]));
    await saving;
  });
  expect(mocks.save).toHaveBeenLastCalledWith('bili', file.path, edited);
  expect(result.current.content).toBe(edited + 'new,active\r\n');
  expect(result.current.hasUnsavedChanges).toBe(true);
});

test('switching files during project lookup cancels the retry', async () => {
  mocks.save.mockResolvedValueOnce(denied());
  let resolveProjects!: (response: Response) => void;
  mocks.projects.mockImplementation(() => new Promise<Response>(resolve => { resolveProjects = resolve; }));
  const { result, rerender } = renderHook(({ currentFile }) => useCodeEditorDocument({ file: currentFile }), { initialProps: { currentFile: file } });
  await waitFor(() => expect(result.current.loading).toBe(false));
  let saving!: Promise<void>;
  act(() => { saving = result.current.handleSave(); });
  await waitFor(() => expect(mocks.projects).toHaveBeenCalled());
  rerender({ currentFile: { ...file, path: '/workspace/conversation/another.csv' } });
  await act(async () => {
    resolveProjects(json([{ projectId: 'bili', fullPath: '/workspace/BiliUploadAuto' }]));
    await saving;
  });
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(result.current.saveError).toBeNull();
});
