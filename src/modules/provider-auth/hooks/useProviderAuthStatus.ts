import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';
import type {
  LLMProvider,
  ProviderAuthStatus,
  ProviderAuthStatusMap,
  ProviderAuthSubscriptionOverride,
} from '@/shared/types';

const CLI_PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode'];

const createInitialProviderAuthStatusMap = (loading = true): ProviderAuthStatusMap => ({
  claude: { authenticated: false, email: null, method: null, error: null, loading },
  cursor: { authenticated: false, email: null, method: null, error: null, loading },
  codex: { authenticated: false, email: null, method: null, error: null, loading },
  opencode: { authenticated: false, email: null, method: null, error: null, loading },
});

type ProviderAuthStatusPayload = {
  installed?: boolean;
  authenticated?: boolean;
  email?: string | null;
  method?: string | null;
  error?: string | null;
  subscriptionOverride?: ProviderAuthSubscriptionOverride | null;
  installedVersion?: string | null;
};

type ProviderAuthStatusApiResponse = {
  success: boolean;
  data: ProviderAuthStatusPayload;
};

const FALLBACK_STATUS_ERROR = 'Failed to check authentication status';
const FALLBACK_UNKNOWN_ERROR = 'Unknown error';

const toErrorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : FALLBACK_UNKNOWN_ERROR
);

const toProviderAuthStatus = (
  payload: ProviderAuthStatusPayload,
  fallbackError: string | null = null,
): ProviderAuthStatus => ({
  ...(typeof payload.installed === 'boolean' ? { installed: payload.installed } : {}),
  authenticated: Boolean(payload.authenticated),
  email: payload.email ?? null,
  method: payload.method ?? null,
  error: payload.error ?? fallbackError,
  loading: false,
  // Only the Claude provider ever sends this, and only while a key is bypassing
  // a valid subscription login; keep the key absent otherwise so the shape
  // matches the initial/error statuses above.
  ...(payload.subscriptionOverride ? { subscriptionOverride: payload.subscriptionOverride } : {}),
  // Servers older than this field leave it out; keep it absent rather than
  // claiming the version is unknown.
  ...(payload.installedVersion !== undefined ? { installedVersion: payload.installedVersion } : {}),
});

// Availability is runtime metadata, not an account preference. Keep only booleans
// and check times in this tab's mirror; never persist account or credential details.
const AVAILABILITY_STORAGE_KEY = 'provider-availability-v1';
const AVAILABILITY_CHANGED_EVENT = 'provider-availability-changed';
const AVAILABILITY_CACHE_MS = 60_000;
const AVAILABILITY_REFRESH_MS = 30_000;

type AvailabilityEntry = { available: boolean; checkedAt: number };

// Retains the latest snapshot if sessionStorage is unavailable.
let fallbackAvailabilitySnapshot = '{}';
// Shares in-flight probes between chat prefetching and availability subscribers.
const pendingChecks: Partial<Record<LLMProvider, Promise<ProviderAuthStatus>>> = {};
// Settings login checks supersede older background responses across all consumers.
const availabilityRequestIds: Partial<Record<LLMProvider, number>> = {};

function readAvailabilitySnapshot(): string {
  try {
    return sessionStorage.getItem(AVAILABILITY_STORAGE_KEY) ?? '{}';
  } catch {
    return fallbackAvailabilitySnapshot;
  }
}

function readAvailabilityEntries(snapshot = readAvailabilitySnapshot()): Partial<Record<LLMProvider, AvailabilityEntry>> {
  try {
    const parsed = JSON.parse(snapshot) as Record<string, AvailabilityEntry> | null;
    const entries: Partial<Record<LLMProvider, AvailabilityEntry>> = {};
    for (const provider of CLI_PROVIDERS) {
      const entry = parsed?.[provider];
      if (entry && typeof entry.available === 'boolean' && Number.isFinite(entry.checkedAt)) {
        entries[provider] = entry;
      }
    }
    return entries;
  } catch {
    return {};
  }
}

function publishAvailability(provider: LLMProvider, status: ProviderAuthStatus, confirmed: boolean) {
  const entries = readAvailabilityEntries();
  // A transient transport failure must not erase a working cached choice.
  const available = !confirmed && entries[provider]
    ? entries[provider].available
    : status.authenticated && status.installed !== false && !status.error;
  entries[provider] = { available, checkedAt: Date.now() };
  fallbackAvailabilitySnapshot = JSON.stringify(entries);
  try {
    sessionStorage.setItem(AVAILABILITY_STORAGE_KEY, fallbackAvailabilitySnapshot);
  } catch {
    // The in-memory mirror still serves menus in browsers that deny storage.
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AVAILABILITY_CHANGED_EVENT));
  }
}

async function loadProviderStatus(provider: LLMProvider): Promise<{ status: ProviderAuthStatus; confirmed: boolean }> {
  try {
    const response = await api.providers.authStatus(provider);
    if (response.ok) {
      const payload = await response.json() as ProviderAuthStatusApiResponse;
      if (!payload.success || !payload.data) throw new Error(FALLBACK_STATUS_ERROR);
      return { status: toProviderAuthStatus(payload.data), confirmed: true };
    }
    return { status: {
      authenticated: false, email: null, method: null, loading: false, error: FALLBACK_STATUS_ERROR,
    }, confirmed: false };
  } catch (error) {
    console.error(`Error checking ${provider} auth status:`, error);
    return { status: {
      authenticated: false, email: null, method: null, loading: false, error: toErrorMessage(error),
    }, confirmed: false };
  }
}

function requestProviderStatus(provider: LLMProvider, force = false): Promise<ProviderAuthStatus> {
  const pending = pendingChecks[provider];
  if (!force && pending) return pending;
  const requestId = (availabilityRequestIds[provider] ?? 0) + 1;
  availabilityRequestIds[provider] = requestId;
  const request = loadProviderStatus(provider).then(({ status, confirmed }) => {
    if (availabilityRequestIds[provider] === requestId) {
      publishAvailability(provider, status, confirmed);
    }
    return status;
  }).finally(() => {
    if (availabilityRequestIds[provider] === requestId) delete pendingChecks[provider];
  });
  pendingChecks[provider] = request;
  return request;
}

/** Used by chat to warm agent availability before the model menu is opened. */
export async function refreshProviderAvailability(): Promise<void> {
  const entries = readAvailabilityEntries();
  await Promise.all(CLI_PROVIDERS.filter((provider) => (
    !entries[provider] || Date.now() - entries[provider].checkedAt >= AVAILABILITY_CACHE_MS
  )).map((provider) => requestProviderStatus(provider)));
}

function subscribeToAvailability(listener: () => void) {
  window.addEventListener(AVAILABILITY_CHANGED_EVENT, listener);
  return () => window.removeEventListener(AVAILABILITY_CHANGED_EVENT, listener);
}

/** Used by chat's model picker to read confirmed availability without waiting for background checks. */
export function useProviderAvailability(): Partial<Record<LLMProvider, boolean>> {
  const snapshot = useSyncExternalStore(subscribeToAvailability, readAvailabilitySnapshot, () => '{}');
  const availability = useMemo(() => {
    const entries = readAvailabilityEntries(snapshot);
    return Object.fromEntries(CLI_PROVIDERS.filter((provider) => entries[provider])
      .map((provider) => [provider, entries[provider]!.available]));
  }, [snapshot]);

  useEffect(() => {
    const refresh = () => { void refreshProviderAvailability(); };
    refresh();
    const interval = window.setInterval(refresh, AVAILABILITY_REFRESH_MS);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return availability;
}

type UseProviderAuthStatusOptions = {
  initialLoading?: boolean;
};

/** Used by settings and onboarding to check CLI installation and sign-in status. */
export function useProviderAuthStatus(
  { initialLoading = true }: UseProviderAuthStatusOptions = {},
) {
  // Each consumer keeps the latest result for each CLI while checks complete independently.
  const [providerAuthStatus, setProviderAuthStatus] = useState<ProviderAuthStatusMap>(() => (
    createInitialProviderAuthStatusMap(initialLoading)
  ));

  // A later explicit sign-in check supersedes an earlier check in this account view.
  const requestIds = useRef<Partial<Record<LLMProvider, number>>>({});

  const setProviderLoading = useCallback((provider: LLMProvider) => {
    setProviderAuthStatus((previous) => ({
      ...previous,
      [provider]: {
        ...previous[provider],
        loading: true,
        error: null,
      },
    }));
  }, []);

  const setProviderStatus = useCallback((provider: LLMProvider, status: ProviderAuthStatus) => {
    setProviderAuthStatus((previous) => ({
      ...previous,
      [provider]: status,
    }));
  }, []);

  const checkProviderAuthStatus = useCallback(async (provider: LLMProvider): Promise<ProviderAuthStatus> => {
    const requestId = (requestIds.current[provider] ?? 0) + 1;
    requestIds.current[provider] = requestId;
    setProviderLoading(provider);
    const status = await requestProviderStatus(provider, true);
    if (requestIds.current[provider] === requestId) {
      setProviderStatus(provider, status);
    }
    return status;
  }, [setProviderLoading, setProviderStatus]);

  const refreshProviderAuthStatuses = useCallback(async (providers: LLMProvider[] = CLI_PROVIDERS) => {
    await Promise.all(providers.map((provider) => checkProviderAuthStatus(provider)));
  }, [checkProviderAuthStatus]);

  return {
    providerAuthStatus,
    checkProviderAuthStatus,
    refreshProviderAuthStatuses,
  };
}
