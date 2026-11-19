import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';
import type { Project } from '@/shared/types';
import { useGitPanelController } from '@/modules/git-panel/hooks/useGitPanelController';

vi.mock('@/shared/hooks/useSelectedProvider', () => ({ useSelectedProvider: () => 'claude' }));
vi.mock('@/shared/api', () => ({
  api: { git: {
    status: vi.fn(), branches: vi.fn(), remoteStatus: vi.fn(),
    fetch: vi.fn(), pull: vi.fn(), push: vi.fn(), publish: vi.fn(),
  } },
}));

const project = { projectId: 'bound-project' } as Project;
const response = (body: unknown) => ({ json: async () => body }) as Response;

beforeEach(() => {
  vi.mocked(api.git.status).mockResolvedValue(response({ branch: 'main', modified: [], added: [], deleted: [], untracked: [] }));
  vi.mocked(api.git.branches).mockResolvedValue(response({ branches: ['main'] }));
  vi.mocked(api.git.remoteStatus).mockResolvedValue(response({ hasRemote: true, ahead: 1 }));
});

test.each([
  ['fetch', 'handleFetch'], ['pull', 'handlePull'], ['push', 'handlePush'], ['publish', 'handlePublish'],
] as const)('%s displays the server error and Git stderr details', async (operation, handler) => {
  vi.mocked(api.git[operation]).mockResolvedValue(response({
    error: 'GitHub authentication or repository permission denied.',
    details: 'remote: Permission to org/repo denied to wrong-user. HTTP 403',
  }));
  const { result } = renderHook(() => useGitPanelController({ selectedProject: project, activeView: 'changes' }));
  await waitFor(() => expect(result.current.currentBranch).toBe('main'));
  await act(async () => { await result.current[handler](); });
  expect(result.current.operationError).toContain('GitHub authentication');
  expect(result.current.operationError).toContain('\nremote: Permission');
  expect(result.current.operationError).toContain('HTTP 403');
});

test('publishing a branch also shows transport failures', async () => {
  vi.mocked(api.git.publish).mockRejectedValue(new Error('Connection interrupted'));
  const { result } = renderHook(() => useGitPanelController({ selectedProject: project, activeView: 'changes' }));
  await waitFor(() => expect(result.current.currentBranch).toBe('main'));
  await act(async () => { await result.current.handlePublish(); });
  expect(result.current.operationError).toBe('Connection interrupted');
  expect(result.current.isPublishing).toBe(false);
});

test('a successful retry clears the previous push error', async () => {
  vi.mocked(api.git.push).mockResolvedValueOnce(response({ error: 'Push failed', details: 'HTTP 403' }))
    .mockResolvedValueOnce(response({ success: true }));
  const { result } = renderHook(() => useGitPanelController({ selectedProject: project, activeView: 'changes' }));
  await waitFor(() => expect(result.current.currentBranch).toBe('main'));
  await act(async () => { await result.current.handlePush(); });
  expect(result.current.operationError).toContain('HTTP 403');
  await act(async () => { await result.current.handlePush(); });
  expect(result.current.operationError).toBeNull();
});
