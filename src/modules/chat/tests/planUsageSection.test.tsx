import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

import PlanUsageSection from '@/modules/chat/modals/PlanUsageSection';

const planUsage = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { providers: { planUsage: (...args: unknown[]) => planUsage(...args) } },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (
      options ? `${key}:${JSON.stringify(options)}` : key
    ),
  }),
}));

const respond = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

describe('PlanUsageSection', () => {
  afterEach(() => {
    planUsage.mockReset();
  });

  it('requests usage for the conversation provider and renders each window', async () => {
    planUsage.mockResolvedValue(respond({
      provider: 'codex',
      status: 'ok',
      planName: 'Pro',
      windows: [{ id: 'weekly', windowMinutes: 10080, usedPercent: 94, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() }],
      credits: null,
      source: 'session-log',
      fetchedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    }));

    render(<PlanUsageSection provider="codex" />);

    await waitFor(() => assert.ok(screen.getByRole('progressbar')));
    assert.equal(planUsage.mock.calls[0][0], 'codex');
    assert.equal(screen.getByRole('progressbar').getAttribute('aria-valuenow'), '94');
  });

  it('shows the unavailable message instead of bars when the login has expired', async () => {
    planUsage.mockResolvedValue(respond({
      provider: 'claude', status: 'token-expired', planName: null, windows: [], credits: null, source: null, fetchedAt: null,
    }));

    render(<PlanUsageSection provider="claude" />);

    await waitFor(() => assert.ok(screen.getByText('planUsage.status.token-expired:{"defaultValue":"planUsage.loadFailed"}')));
    assert.equal(screen.queryByRole('progressbar'), null);
  });

  it('renders nothing and makes no request for providers without plan usage', () => {
    const { container } = render(<PlanUsageSection provider="cursor" />);

    assert.equal(container.firstChild, null);
    assert.equal(planUsage.mock.calls.length, 0);
  });

  it('shows an explicit error when a response has no usage data', async () => {
    planUsage.mockResolvedValue(respond(null));
    render(<PlanUsageSection provider="claude" />);
    await waitFor(() => assert.ok(screen.getByText('planUsage.loadFailed')));
    assert.equal(screen.queryByRole('progressbar'), null);
  });

  it('allows cache on opening and forces a fresh query only on manual refresh', async () => {
    planUsage.mockImplementation(async () => respond({
      provider: 'claude', status: 'ok', windows: [], source: 'cli', fetchedAt: new Date().toISOString(),
    }));
    const panel = render(<PlanUsageSection provider="claude" />);
    await waitFor(() => assert.ok(screen.getByText(/planUsage.updatedFromCli/)));
    assert.deepEqual(planUsage.mock.calls, [['claude', false]]);
    fireEvent.click(screen.getByRole('button', { name: 'planUsage.refresh' }));
    await waitFor(() => assert.equal(planUsage.mock.calls.length, 2));
    assert.deepEqual(planUsage.mock.calls[1], ['claude', true]);
    panel.unmount();
    render(<PlanUsageSection provider="claude" />);
    await waitFor(() => assert.equal(planUsage.mock.calls.length, 3));
    assert.deepEqual(planUsage.mock.calls[2], ['claude', false]);
  });
});

it('labels Claude queries with their actual source and age', async () => {
  planUsage.mockResolvedValue(respond({
    provider: 'claude', status: 'ok', planName: null, credits: null,
    windows: [{ id: 'five_hour', usedPercent: 42, windowMinutes: 300, resetsAt: new Date(Date.now() + 3600000).toISOString() }],
    source: 'cli', fetchedAt: new Date(Date.now() - 600000).toISOString(),
  }));
  render(<PlanUsageSection provider="claude" />);
  await waitFor(() => assert.equal(screen.getByRole('progressbar').getAttribute('aria-valuenow'), '42'));
  assert.ok(screen.getByText(/planUsage.updatedFromCli/));
  assert.equal(screen.queryByText('planUsage.updatedLive'), null);
});

it('shows a query timeout instead of a blank section or fabricated zero', async () => {
  planUsage.mockResolvedValue(respond({ provider: 'claude', status: 'timeout', windows: [], source: null, fetchedAt: null }));
  render(<PlanUsageSection provider="claude" />);
  await waitFor(() => assert.ok(screen.getByText('planUsage.status.timeout:{"defaultValue":"planUsage.loadFailed"}')));
  assert.equal(screen.queryByRole('progressbar'), null);
});


it('keeps the previous result on reopening and spins the refresh icon until the new result arrives', async () => {
  const usage = (percent: number) => ({ provider: 'claude', status: 'ok',
    windows: [{ id: 'five_hour', usedPercent: percent, resetsAt: '2026-11-02T16:05:00Z' }],
    source: 'cli', fetchedAt: new Date().toISOString() });
  planUsage.mockImplementation(async () => respond(usage(73)));
  const first = render(<PlanUsageSection provider="claude" />);
  await waitFor(() => assert.equal(screen.getByRole('progressbar').getAttribute('aria-valuenow'), '73'));
  assert.ok(screen.getByText('00:05 UTC+8'));
  assert.ok(screen.getByText('planUsage.updatedFromCli:{"duration":"planUsage.justNow"}'));
  first.unmount();
  let finish!: (response: Response) => void;
  planUsage.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  render(<PlanUsageSection provider="claude" />);
  assert.equal(screen.getByRole('progressbar').getAttribute('aria-valuenow'), '73');
  const button = screen.getByRole('button', { name: 'planUsage.refresh' });
  assert.equal(button.hasAttribute('disabled'), true);
  assert.ok(button.querySelector('svg')?.classList.contains('animate-spin'));
  assert.equal(screen.queryByText('planUsage.loading'), null);
  await act(async () => finish(respond(usage(82))));
  await waitFor(() => assert.equal(screen.getByRole('progressbar').getAttribute('aria-valuenow'), '82'));
  assert.equal(button.hasAttribute('disabled'), false);
  assert.equal(button.querySelector('svg')?.classList.contains('animate-spin'), false);

  planUsage.mockRejectedValue(new Error('offline'));
  fireEvent.click(button);
  await waitFor(() => assert.ok(screen.getByText('planUsage.loadFailed')));
  assert.equal(screen.getByRole('progressbar').getAttribute('aria-valuenow'), '82');
});


it('refreshes the actual result age using the server clock even when the device is 59 minutes ahead', async () => {
  const serverNow = Date.parse('2026-11-02T05:32:18Z');
  const deviceClock = vi.spyOn(Date, 'now').mockReturnValue(serverNow + 59 * 60_000);
  let fetchedAt = serverNow - 59 * 60_000;
  planUsage.mockImplementation(async () => new Response(JSON.stringify({ data: {
    provider: 'codex', status: 'ok', windows: [], source: 'cli', fetchedAt: new Date(fetchedAt).toISOString(),
  } }), { headers: { Date: new Date(serverNow).toUTCString() } }));
  try {
    const first = render(<PlanUsageSection provider="codex" />);
    await waitFor(() => assert.ok(screen.getByText(/planUsage.updatedFromCodexCli.*59/)));
    fetchedAt = serverNow;
    fireEvent.click(screen.getByRole('button', { name: 'planUsage.refresh' }));
    await waitFor(() => assert.ok(screen.getByText('planUsage.updatedFromCodexCli:{"duration":"planUsage.justNow"}')));
    first.unmount();
    planUsage.mockImplementation(() => new Promise(() => {}));
    render(<PlanUsageSection provider="codex" />);
    assert.ok(screen.getByText('planUsage.updatedFromCodexCli:{"duration":"planUsage.justNow"}'));
  } finally { deviceClock.mockRestore(); }
});
