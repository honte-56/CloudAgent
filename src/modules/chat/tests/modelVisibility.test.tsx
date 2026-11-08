import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import type { LLMProvider, ProjectSession } from '@/shared/types';
import { hydrateUserPreferences, resetUserPreferences, saveUserPreference, writeUserPreference } from '@/shared/userSettings';

const mocks = vi.hoisted(() => ({ sessionModel: null as string | null, serverPreferences: {} as Record<string, unknown> }));
const response = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
vi.mock('@/shared/api', () => ({ api: {
  user: {
    savePreferences: () => response({ success: true }),
    preferences: () => response({ success: true, preferences: mocks.serverPreferences }),
  },
  providers: {
    authStatus: () => response({ success: true, data: { installed: true, authenticated: true } }),
    models: (provider: string) => response({ success: true, data: { models: {
      DEFAULT: `${provider}/default`,
      OPTIONS: [{ value: `${provider}/default`, label: 'Default' }, { value: `${provider}/chosen`, label: 'Chosen' }],
    } } }),
    capabilities: () => response({ success: true, data: null }),
    sessionActiveModel: () => response({ success: true, data: { model: mocks.sessionModel, source: 'session' } }),
  },
} }));

beforeEach(async () => {
  await i18n.changeLanguage('en');
  localStorage.clear();
  resetUserPreferences();
  mocks.sessionModel = null;
  mocks.serverPreferences = {};
});

test.each<LLMProvider>(['claude', 'codex', 'opencode', 'cursor'])('limits %s choices and moves a hidden new-chat default to a selected model', async (provider) => {
  writeUserPreference('selectedProvider', provider);
  writeUserPreference(`${provider}VisibleModels`, [`${provider}/chosen`]);
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  await waitFor(() => expect(result.current.providerModelsLoading).toBe(false));
  expect(result.current.currentProviderModelOptions.map((option) => option.value)).toEqual([`${provider}/chosen`]);
  expect(result.current.currentProviderModel).toBe(`${provider}/chosen`);
  expect(result.current.providerModelCatalog[provider]?.OPTIONS).toHaveLength(2);
  for (const other of ['claude', 'codex', 'opencode', 'cursor'] as const) {
    if (other !== provider) expect(result.current.providerModels[other]).toBe(`${other}/default`);
  }
});

test('confirmed settings saves update an already open chat without reloading its catalog', async () => {
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  await waitFor(() => expect(result.current.providerModelsLoading).toBe(false));
  await act(() => saveUserPreference('claudeVisibleModels', ['claude/chosen']));
  expect(result.current.currentProviderModelOptions.map((option) => option.value)).toEqual(['claude/chosen']);
  expect(result.current.currentProviderModel).toBe('claude/chosen');
  await act(() => saveUserPreference('claudeVisibleModels', null));
  expect(result.current.currentProviderModelOptions).toHaveLength(2);
});

test('an existing session keeps its recorded model when it is hidden from the picker', async () => {
  mocks.sessionModel = 'claude/default';
  writeUserPreference('claudeVisibleModels', ['claude/chosen']);
  const selectedSession: ProjectSession = { id: 'session-1', __provider: 'claude' };
  const { result } = renderHook(() => useChatProviderState({ selectedSession, selectedProject: null }));
  await waitFor(() => expect(result.current.providerModelsLoading).toBe(false));
  await waitFor(() => expect(result.current.currentProviderModel).toBe('claude/default'));
  expect(result.current.currentProviderModelOptions.map((option) => option.value)).toEqual(['claude/chosen']);
});

test('account hydration on another device restores visibility and missing models keep the picker usable', async () => {
  mocks.serverPreferences = { opencodeVisibleModels: ['opencode/chosen'], selectedProvider: 'opencode' };
  await hydrateUserPreferences();
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  await waitFor(() => expect(result.current.providerModelsLoading).toBe(false));
  expect(result.current.currentProviderModelOptions.map((option) => option.value)).toEqual(['opencode/chosen']);
  act(() => writeUserPreference('opencodeVisibleModels', ['removed-provider/old-model']));
  expect(result.current.currentProviderModelOptions).toHaveLength(2);
});

const modelActions = {
  create: async () => {}, update: async () => {}, remove: async () => {}, setCustomModelsOnly: async () => {},
};
const openCodeCatalog = {
  DEFAULT: 'opencode/default',
  OPTIONS: [{ value: 'opencode/default', label: 'Default' }, { value: 'opencode/chosen', label: 'Chosen' }],
};

test.each(['catalog', 'command response'] as const)('/model filters choices from the %s', (source) => {
  writeUserPreference('opencodeVisibleModels', ['opencode/chosen']);
  render(<CommandResultModal
    payload={{ kind: 'models', data: { current: { provider: 'opencode' }, availableOptions: openCodeCatalog.OPTIONS } }}
    onClose={() => {}}
    providerModelCatalog={source === 'catalog' ? { opencode: openCodeCatalog } : {}}
    providerModelActions={modelActions}
    activeProvider="opencode"
    activeProviderModel="opencode/default"
    currentSessionId={null}
    onSelectProviderModel={async (_, model) => ({ scope: 'default', model })}
  />);
  expect(screen.getByRole('button', { name: 'Select model opencode/chosen' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Select model opencode/default' })).toBe(null);
});

test('the new conversation picker filters its provider groups', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => {};
  writeUserPreference('opencodeVisibleModels', ['opencode/chosen']);
  render(<ProviderSelectionEmptyState
    selectedSession={null} currentSessionId={null} provider="opencode" setProvider={() => {}}
    textareaRef={{ current: null }}
    providerModels={{ claude: '', codex: '', cursor: '', opencode: 'opencode/chosen' }}
    setProviderModel={() => {}}
    providerModelCatalog={{ opencode: openCodeCatalog }}
    providerModelActions={modelActions}
    providerModelsLoading={false} tasksEnabled={false} isTaskMasterInstalled={null} setInput={() => {}}
  />);
  fireEvent.click(screen.getByRole('button', { name: /Click to change model/ }));
  await screen.findByRole('option');
  const choices = screen.getAllByRole('option');
  expect(choices).toHaveLength(1);
  expect(choices[0].textContent).toContain('opencode/chosen');
  vi.unstubAllGlobals();
});
