import type { LLMProvider, ProviderModelsDefinition } from '@/shared/index.js';

const CATALOG_TTL_MS = 5 * 60_000;
const FAILURE_RETRY_MS = 30_000;

/** Used by the model service to share CLI reads, cache successes, and expose failed refreshes honestly. */
export function createProviderModelDiscovery(now: () => number = Date.now) {
  const cache = new Map<LLMProvider, { catalog: ProviderModelsDefinition; expiresAt: number }>();
  const pending = new Map<LLMProvider, Promise<ProviderModelsDefinition>>();

  return async (
    provider: LLMProvider,
    read: () => Promise<ProviderModelsDefinition>,
    refresh = false,
  ): Promise<ProviderModelsDefinition> => {
    // Other adapters retain their existing catalog behavior.
    if (provider !== 'codex' && provider !== 'claude') return read();
    const inFlight = pending.get(provider);
    if (inFlight) return structuredClone(await inFlight);
    const previous = cache.get(provider);
    if (!refresh && previous && previous.expiresAt > now()) return structuredClone(previous.catalog);

    const request = (async () => {
      try {
        const result = await read();
        if (!result.OPTIONS.length) throw new Error('The CLI returned no models.');
        const catalog: ProviderModelsDefinition = {
          ...result,
          DISCOVERY: { status: 'ready', updatedAt: new Date(now()).toISOString() },
        };
        cache.set(provider, { catalog, expiresAt: now() + CATALOG_TTL_MS });
        return catalog;
      } catch {
        // Never substitute a source-controlled list or turn a failed refresh into an empty success.
        const lastGood = previous?.catalog.DISCOVERY?.updatedAt ? previous.catalog : undefined;
        const catalog: ProviderModelsDefinition = {
          ...(lastGood ?? { OPTIONS: [], DEFAULT: provider === 'claude' ? 'default' : '' }),
          DISCOVERY: {
            status: lastGood ? 'stale' : 'unavailable',
            ...(lastGood ? { updatedAt: lastGood.DISCOVERY!.updatedAt } : {}),
          },
        };
        cache.set(provider, { catalog, expiresAt: now() + FAILURE_RETRY_MS });
        return catalog;
      }
    })();
    pending.set(provider, request);
    try { return structuredClone(await request); }
    finally { pending.delete(provider); }
  };
}
