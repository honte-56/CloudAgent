import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { useProviderAuthStatus } from '@/modules/provider-auth/hooks/useProviderAuthStatus';
import type { ProviderAuthStatus } from '@/shared/types';

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { providers: { authStatus: mocks.auth } } }));

test('a slow earlier check cannot hide a channel confirmed available by a newer check', async () => {
  let finishFirst!: (response: Response) => void;
  const firstResponse = new Promise<Response>((resolve) => { finishFirst = resolve; });
  mocks.auth.mockReturnValueOnce(firstResponse).mockResolvedValueOnce(new Response(JSON.stringify({
    success: true, data: { installed: true, authenticated: true },
  })));
  const { result } = renderHook(() => useProviderAuthStatus());
  let firstRequest!: Promise<ProviderAuthStatus>;
  act(() => { firstRequest = result.current.checkProviderAuthStatus('cursor'); });
  await act(async () => { await result.current.checkProviderAuthStatus('cursor'); });
  expect(result.current.providerAuthStatus.cursor.authenticated).toBe(true);
  expect(result.current.providerAuthStatus.cursor.installed).toBe(true);
  await act(async () => {
    finishFirst(new Response(JSON.stringify({ success: true, data: { installed: false, authenticated: false } })));
    await firstRequest;
  });
  expect(result.current.providerAuthStatus.cursor.authenticated).toBe(true);
  expect(result.current.providerAuthStatus.cursor.installed).toBe(true);
  expect(result.current.providerAuthStatus.cursor.loading).toBe(false);
});
