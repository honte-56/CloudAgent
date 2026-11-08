import { useMemo, useSyncExternalStore } from 'react';

import type { LLMProvider } from '@/shared/types';
import { readUserPreference, saveUserPreference, subscribeToUserPreferences } from '@/shared/userSettings';

function useProviderSelection(provider: LLMProvider) {
  return useSyncExternalStore(
    subscribeToUserPreferences,
    () => readUserPreference<string[] | null>(`${provider}VisibleModels`, null),
  );
}

async function saveVisibleModels(provider: LLMProvider, selection: string[] | null) {
  await saveUserPreference(`${provider}VisibleModels`, selection);
}

/** Shares account-backed model visibility between settings and all conversation model pickers. */
export function useModelVisibility() {
  const claude = useProviderSelection('claude');
  const cursor = useProviderSelection('cursor');
  const codex = useProviderSelection('codex');
  const opencode = useProviderSelection('opencode');
  const visibleModels = useMemo(() => ({ claude, cursor, codex, opencode }), [claude, cursor, codex, opencode]);
  return { visibleModels, saveVisibleModels };
}
