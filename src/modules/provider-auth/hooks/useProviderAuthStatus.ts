import { useCallback, useRef, useState } from 'react';

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

type UseProviderAuthStatusOptions = {
  initialLoading?: boolean;
};

/** Used by settings, onboarding and chat to check CLI installation and sign-in status. */
export function useProviderAuthStatus(
  { initialLoading = true }: UseProviderAuthStatusOptions = {},
) {
  // Each consumer keeps the latest result for each CLI while checks complete independently.
  const [providerAuthStatus, setProviderAuthStatus] = useState<ProviderAuthStatusMap>(() => (
    createInitialProviderAuthStatusMap(initialLoading)
  ));

  // Reopening the model picker or completing login can supersede a slow earlier check.
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
    const publishStatus = (status: ProviderAuthStatus) => {
      if (requestIds.current[provider] === requestId) {
        setProviderStatus(provider, status);
      }
    };

    try {
      const response = await api.providers.authStatus(provider);

      if (!response.ok) {
        const status: ProviderAuthStatus = {
          authenticated: false,
          email: null,
          method: null,
          loading: false,
          error: FALLBACK_STATUS_ERROR,
        };
        publishStatus(status);
        return status;
      }

      const payload = (await response.json()) as ProviderAuthStatusApiResponse;
      const status = toProviderAuthStatus(payload.data);
      publishStatus(status);
      return status;
    } catch (caughtError) {
      console.error(`Error checking ${provider} auth status:`, caughtError);
      const status: ProviderAuthStatus = {
        authenticated: false,
        email: null,
        method: null,
        loading: false,
        error: toErrorMessage(caughtError),
      };
      publishStatus(status);
      return status;
    }
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
