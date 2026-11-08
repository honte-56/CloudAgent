import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import type { LLMProvider, ProviderModelActions, ProviderModelsDefinition } from '@/shared/types';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: {
  providers: { authStatus: mocks.auth },
  user: { savePreferences: async () => ({ ok: true }) },
} }));
vi.mock('@/modules/task-master', () => ({ NextTaskBanner: () => null }));

const PROVIDERS: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode'];
const CATALOG = Object.fromEntries(PROVIDERS.map((provider) => [provider, {
  DEFAULT: `${provider}-primary`,
  OPTIONS: [
    { value: `${provider}-primary`, label: `${provider} primary` },
    { value: `${provider}-secondary`, label: `${provider} secondary` },
  ],
}])) as Record<LLMProvider, ProviderModelsDefinition>;
const ACTIONS: ProviderModelActions = {
  create: async () => {}, update: async () => {}, remove: async () => {}, setCustomModelsOnly: async () => {},
};
function status(data: Record<string, unknown>) {
  return Promise.resolve({ ok: true, json: async () => ({ success: true, data }) });
}
function renderPicker(catalog = CATALOG) {
  return render(<ProviderSelectionEmptyState
    selectedSession={null} currentSessionId={null} provider="claude" setProvider={() => {}}
    textareaRef={{ current: null }}
    providerModels={{ claude: 'claude-primary', codex: 'codex-primary', cursor: 'cursor-primary', opencode: 'opencode-primary' }}
    setProviderModel={() => {}} providerModelCatalog={catalog} providerModelActions={ACTIONS}
    providerModelsLoading={false} tasksEnabled={false} isTaskMasterInstalled={null} setInput={() => {}}
  />);
}
function openPicker() {
  fireEvent.click(screen.getByRole('button', { name: /Click to change model/ }));
}

beforeEach(async () => {
  localStorage.clear();
  resetUserPreferences();
  await i18n.changeLanguage('en');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => {};
  mocks.auth.mockReset().mockImplementation(() => status({ installed: true, authenticated: true }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetUserPreferences();
});

test('hides logged-out and uninstalled channels while retaining chosen models for available channels', async () => {
  mocks.auth.mockImplementation((provider: LLMProvider) => status({
    installed: provider !== 'cursor', authenticated: provider !== 'claude',
  }));
  writeUserPreference('opencodeVisibleModels', ['opencode-primary']);
  renderPicker();
  expect(mocks.auth).not.toHaveBeenCalled();
  openPicker();
  await screen.findByText('OpenCode');
  expect(screen.queryByText('Anthropic')).toBeNull();
  expect(screen.queryByText('Cursor')).toBeNull();
  expect(screen.getByText('OpenAI')).toBeTruthy();
  expect(screen.getAllByRole('option')).toHaveLength(3);
  expect(screen.queryByText('opencode secondary')).toBeNull();
});

test('a failed check hides that channel without blocking available ones', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.auth.mockImplementation((provider: LLMProvider) => provider === 'cursor'
    ? Promise.reject(new Error('unavailable')) : status({ installed: true, authenticated: true }));
  renderPicker();
  openPicker();
  await screen.findByText('OpenCode');
  expect(screen.queryByText('Cursor')).toBeNull();
  expect(screen.getAllByRole('option')).toHaveLength(6);
});

test('an authenticated channel with a reported runtime error is hidden', async () => {
  mocks.auth.mockImplementation((provider: LLMProvider) => status({
    installed: true, authenticated: true, error: provider === 'cursor' ? 'CLI failed' : null,
  }));
  renderPicker();
  openPicker();
  await screen.findByText('OpenCode');
  expect(screen.queryByText('Cursor')).toBeNull();
});

test('pending checks do not expose channels or show an empty-results error', async () => {
  let resolveCheck!: (value: Awaited<ReturnType<typeof status>>) => void;
  const pending = new Promise<Awaited<ReturnType<typeof status>>>((resolve) => { resolveCheck = resolve; });
  mocks.auth.mockReturnValue(pending);
  renderPicker();
  openPicker();
  expect(screen.queryByRole('option')).toBeNull();
  expect(screen.getByText('Checking available agents…')).toBeTruthy();
  expect(screen.queryByText('No models found.')).toBeNull();
  await act(async () => resolveCheck(await status({ installed: true, authenticated: true })));
  await screen.findByText('Cursor');
  expect(screen.getAllByRole('option')).toHaveLength(8);
});

test('reopening checks again so a newly logged-in channel appears without reloading the page', async () => {
  let signedIn = false;
  mocks.auth.mockImplementation((provider: LLMProvider) => status({
    installed: true, authenticated: provider !== 'cursor' || signedIn,
  }));
  renderPicker();
  openPicker();
  await screen.findByText('OpenCode');
  expect(screen.queryByText('Cursor')).toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  signedIn = true;
  openPicker();
  await screen.findByText('Cursor');
  expect(mocks.auth).toHaveBeenCalledTimes(8);
});

test('an empty availability result explains how to configure a channel', async () => {
  mocks.auth.mockImplementation(() => status({ installed: false, authenticated: false }));
  renderPicker();
  openPicker();
  await screen.findByText('No agents are available. Sign in to an installed agent in Settings.');
  expect(screen.queryByRole('option')).toBeNull();
  // Management remains reachable even when nothing can currently start a conversation.
  expect(screen.getByRole('button', { name: 'Add model' })).toBeTruthy();
});

test('an unknown version or an older auth response does not hide a working channel', async () => {
  mocks.auth.mockImplementation((provider: LLMProvider) => status(provider === 'cursor'
    ? { installed: true, installedVersion: null, authenticated: true } : { authenticated: true }));
  renderPicker();
  openPicker();
  await screen.findByText('Cursor');
  expect(screen.getAllByRole('option')).toHaveLength(8);
});

test('authenticated channels with no models are omitted from the selection list', async () => {
  renderPicker({ ...CATALOG, cursor: { DEFAULT: '', OPTIONS: [] } });
  openPicker();
  await screen.findByText('OpenCode');
  expect(screen.queryByText('Cursor')).toBeNull();
});
