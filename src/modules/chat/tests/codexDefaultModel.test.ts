import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';
import type { ProviderModelsDefinition } from '@/shared/types';

/** Native catalog defaults hydrate the composer without a hardcoded Codex model. */
const CODEX_CATALOG: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { value: 'gpt-5.5', label: 'GPT-5.5' },
  ],
  DEFAULT: 'gpt-5.6-sol',
};

// What GET /api/providers/codex/models answers with; null keeps the catalog
// unloaded, which is the window the composer's pre-catalog fallback covers.
let codexCatalog: ProviderModelsDefinition | null = null;
let modelRequests: Array<{ provider: string; refresh: boolean }> = [];

const okJson = (data: unknown) => Promise.resolve({
  ok: true,
  json: async () => data,
});

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: (provider: string, refresh = false) => {
        modelRequests.push({ provider, refresh });
        return okJson({ success: true, data: provider === 'codex' && codexCatalog ? { models: codexCatalog } : null });
      },
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
    },
  },
}));

const renderCodexProviderState = async () => {
  // The provider follows the user through the preference store, while the
  // per-provider model is per-browser localStorage.
  writeUserPreference('selectedProvider', 'codex');
  const { useChatProviderState } = await import(
    '@/modules/chat/hooks/useChatProviderState'
  );
  return renderHook(() =>
    useChatProviderState({ selectedSession: null, selectedProject: null }),
  );
};

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  codexCatalog = null;
  modelRequests = [];
});

afterEach(() => {
  vi.resetModules();
});

test('a new browser leaves Codex model unspecified until the CLI catalog loads', async () => {
  const { result } = await renderCodexProviderState();

  await waitFor(() => {
    assert.equal(result.current.provider, 'codex');
  });
  assert.equal(result.current.currentProviderModel, '');
});

test('a browser that remembered GPT-5.4 moves to the catalog default once the catalog loads', async () => {
  localStorage.setItem('codex-model', 'gpt-5.4');
  codexCatalog = CODEX_CATALOG;

  const { result } = await renderCodexProviderState();

  await waitFor(() => {
    assert.equal(result.current.providerModelCatalog.codex?.DEFAULT, 'gpt-5.6-sol');
    assert.equal(result.current.currentProviderModel, 'gpt-5.6-sol');
  });
  assert.equal(localStorage.getItem('codex-model'), 'gpt-5.6-sol');
});


test('menu reads use the cache while manual refresh requests a new CLI catalog for only the active provider', async () => {
  codexCatalog = CODEX_CATALOG;
  const { result } = await renderCodexProviderState();
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));
  modelRequests = [];
  await act(async () => { await result.current.refreshCurrentModels(); });
  assert.deepEqual(modelRequests, [{ provider: 'codex', refresh: false }]);
  codexCatalog = { OPTIONS: [{ value: 'future-cli-default', label: 'Future CLI model' }], DEFAULT: 'future-cli-default' };
  await act(async () => { await result.current.refreshCurrentModels(true); });
  assert.deepEqual(modelRequests[1], { provider: 'codex', refresh: true });
  assert.equal(result.current.currentProviderModel, 'future-cli-default');
});

test('a failed refresh keeps the last choices and selected model with a visible stale status', async () => {
  codexCatalog = CODEX_CATALOG;
  const { result } = await renderCodexProviderState();
  await waitFor(() => assert.equal(result.current.currentProviderModel, CODEX_CATALOG.DEFAULT));
  codexCatalog = null;
  await act(async () => { await result.current.refreshCurrentModels(true); });
  assert.equal(result.current.providerModelCatalog.codex?.DISCOVERY?.status, 'stale');
  assert.deepEqual(result.current.currentProviderModelOptions.map((option) => option.value), CODEX_CATALOG.OPTIONS.map((option) => option.value));
  assert.equal(result.current.currentProviderModel, CODEX_CATALOG.DEFAULT);
});

test('initial discovery failure preserves a saved selection instead of replacing it with a fixed default', async () => {
  localStorage.setItem('codex-model', 'my-saved-model');
  const { result } = await renderCodexProviderState();
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));
  assert.equal(result.current.providerModelCatalog.codex?.DISCOVERY?.status, 'unavailable');
  assert.equal(result.current.currentProviderModel, 'my-saved-model');
  assert.equal(localStorage.getItem('codex-model'), 'my-saved-model');
});
