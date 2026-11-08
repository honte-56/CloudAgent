import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { refreshProviderAvailability, useProviderAuthStatus, useProviderAvailability } from '@/modules/provider-auth/hooks/useProviderAuthStatus';

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { providers: { authStatus: mocks.auth } } }));
const response = (authenticated: boolean) => ({
  ok: true,
  json: async () => ({ success: true, data: { installed: true, authenticated } }),
});

beforeEach(() => {
  sessionStorage.clear();
  mocks.auth.mockReset().mockResolvedValue(response(true));
});

test('a failed background refresh keeps the last confirmed choices', async () => {
  const { result } = renderHook(() => useProviderAvailability());
  await waitFor(() => expect(result.current.claude).toBe(true));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  mocks.auth.mockRejectedValue(new Error('network unavailable'));
  await act(async () => { await refreshProviderAvailability(); });
  expect(Object.values(result.current)).toEqual([true, true, true, true]);
});

test('a confirmed sign-out immediately removes an available channel from every subscriber', async () => {
  const one = renderHook(() => useProviderAvailability());
  const two = renderHook(() => useProviderAvailability());
  await waitFor(() => expect(one.result.current.cursor).toBe(true));
  // Both readers share the same four in-flight checks.
  expect(mocks.auth).toHaveBeenCalledTimes(4);
  mocks.auth.mockResolvedValue(response(false));
  const settings = renderHook(() => useProviderAuthStatus());
  await act(async () => { await settings.result.current.checkProviderAuthStatus('cursor'); });
  expect(one.result.current.cursor).toBe(false);
  expect(two.result.current.cursor).toBe(false);
});

test('a slow background result cannot overwrite a newer settings login result', async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  const pending = new Promise<ReturnType<typeof response>>((resolve) => { finish = resolve; });
  mocks.auth.mockReturnValue(pending);
  const menu = renderHook(() => useProviderAvailability());
  const settings = renderHook(() => useProviderAuthStatus());
  mocks.auth.mockResolvedValue(response(true));
  await act(async () => { await settings.result.current.checkProviderAuthStatus('cursor'); });
  expect(menu.result.current.cursor).toBe(true);
  await act(async () => { finish(response(false)); });
  expect(menu.result.current.cursor).toBe(true);
  expect(menu.result.current.claude).toBe(false);
});

test('menus can reuse confirmed availability when browser storage is disabled', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage disabled'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage disabled'); });
  const first = renderHook(() => useProviderAvailability());
  await waitFor(() => expect(first.result.current.claude).toBe(true));
  first.unmount();
  const second = renderHook(() => useProviderAvailability());
  expect(second.result.current.claude).toBe(true);
  expect(mocks.auth).toHaveBeenCalledTimes(4);
});
