import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { LLMProvider, ProviderModelOption, ProviderModelsDefinition } from '@/shared/types';

/** Loads the unfiltered catalog for the settings module's model visibility editor. */
export function useAgentModels(provider: LLMProvider) {
  // Retains the request outcome so failed catalogs cannot be mistaken for an empty model list.
  const [catalog, setCatalog] = useState<{ options: ProviderModelOption[]; status: 'loading' | 'ready' | 'error'; discovery?: ProviderModelsDefinition['DISCOVERY'] }>({
    options: [], status: 'loading',
  });
  // A retry starts a new effect and cancels publication from the previous request.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setCatalog({ options: [], status: 'loading' });
    async function load() {
      try {
        const response = await api.providers.models(provider, attempt > 0);
        const body = await response.json() as { success?: boolean; data?: { models?: ProviderModelsDefinition } };
        if (!response.ok || !body.success || !Array.isArray(body.data?.models?.OPTIONS)) {
          throw new Error('Unable to load models.');
        }
        if (!cancelled) {
          setCatalog({ options: body.data.models.OPTIONS, status: 'ready', discovery: body.data.models.DISCOVERY });
        }
      } catch {
        if (!cancelled) {
          setCatalog({ options: [], status: 'error' });
        }
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [provider, attempt]);

  return { ...catalog, reload: () => setAttempt((current) => current + 1) };
}
