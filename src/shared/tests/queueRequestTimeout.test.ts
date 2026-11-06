import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { api } from '@/shared/api';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('only manual usage refresh sends the cache bypass flag', async () => {
  const serverDate = 'Mon, 02 Nov 2026 05:32:18 GMT';
  const fetchMock = vi.fn(async () => new Response('{}', { headers: { Date: serverDate } }));
  vi.stubGlobal('fetch', fetchMock);
  const response = await api.providers.planUsage('claude');
  assert.equal(response.headers.get('Date'), serverDate);
  await api.providers.planUsage('claude', true);
  const urls = (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(call => call[0]);
  assert.deepEqual(urls, ['/api/providers/claude/plan-usage', '/api/providers/claude/plan-usage?refresh=true']);
  assert.ok((fetchMock.mock.calls as unknown as [string, RequestInit][]).every(([, options]) => options.cache === 'no-store'));
});

test('a stalled usage query aborts after 25 seconds instead of spinning forever', async () => {
  const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetchMock);
  const rejection = assert.rejects(api.providers.planUsage('claude'), /Usage query timed out/);
  await vi.advanceTimersByTimeAsync(25_000);
  await rejection;
  const options = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0][1];
  assert.equal(options.signal?.aborted, true);
  assert.equal(fetchMock.mock.calls.length, 1);
});

for (const stage of ['save', 'steer', 'read', 'delete'] as const) {
  test(`a stalled ${stage} request times out and aborts HTTP without retrying`, async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const pending = stage === 'save' ? api.user.saveDraft('a', { text: '', queuedMessage: { content: 'hello' } })
      : stage === 'steer' ? api.providers.steerSession('a', 'hello', [], true)
        : stage === 'delete' ? api.user.deleteDraft('a') : api.user.drafts();
    const rejection = assert.rejects(pending, /超时/);
    await vi.advanceTimersByTimeAsync(stage === 'steer' ? 35_000 : 10_000);
    await rejection;
    assert.equal(fetchMock.mock.calls.length, 1);
    const options = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0][1];
    assert.equal(options.signal?.aborted, true);
  });
}

test('a received header with a stalled confirmation body also times out', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ headers: new Headers(), status: 200, text: () => new Promise<string>(() => {}) })));
  const rejection = assert.rejects(api.providers.steerSession('a', 'hello', [], true), /消息可能已经送达/);
  await vi.advanceTimersByTimeAsync(35_000);
  await rejection;
});

test('an acknowledged delivery keeps its response and clears the deadline', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { delivered: true } }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const response = await api.providers.steerSession('a', 'hello', [], true);
  assert.deepEqual(await response.json(), { data: { delivered: true } });
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(fetchMock.mock.calls.length, 1);
});
