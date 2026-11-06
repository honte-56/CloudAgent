import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Gauge, RefreshCw } from 'lucide-react';

import { api } from '@/shared/api';

type PlanUsageWindow = {
  id: string;
  windowMinutes: number | null;
  usedPercent: number;
  resetsAt: string | null;
};

type PlanUsageData = {
  provider: string;
  status: 'ok' | 'unauthenticated' | 'token-expired' | 'unsupported' | 'timeout' | 'error';
  planName: string | null;
  windows: PlanUsageWindow[];
  credits: { balance: string | null; unlimited: boolean } | null;
  source: 'live' | 'session-log' | 'cli' | null;
  fetchedAt: string | null;
  message?: string;
};

type PlanUsageSnapshot = {
  data: PlanUsageData;
  serverTimeMs: number;
  receivedAtMs: number;
};

// Preserve the last successful result across modal unmounts; the server still
// decides whether opening may use its five-minute cache or needs a fresh query.
const lastSuccessfulUsage = new Map<string, PlanUsageSnapshot>();

const PROVIDERS_WITH_PLAN_USAGE = new Set(['claude', 'codex']);

type PlanUsageSectionProps = {
  provider: string | undefined;
};

const RESET_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

const KNOWN_WINDOW_IDS = new Set(['five_hour', 'weekly', 'weekly_opus', 'weekly_sonnet']);

const barToneClass = (percent: number) => {
  if (percent >= 90) {
    return 'bg-red-500';
  }
  if (percent >= 70) {
    return 'bg-amber-500';
  }
  return 'bg-primary';
};

const formatDuration = (deltaMs: number) => {
  const minutes = Math.max(0, Math.round(deltaMs / 60_000));
  if (minutes < 60) {
    return { unit: 'minutes' as const, count: minutes };
  }
  if (minutes < 48 * 60) {
    return { unit: 'hours' as const, count: Math.round(minutes / 60) };
  }
  return { unit: 'days' as const, count: Math.round(minutes / (24 * 60)) };
};

/**
 * Rendered inside the /cost token-usage modal: shows the subscription's
 * rate-limit windows for the conversation's provider (Claude or Codex).
 */
export default function PlanUsageSection({ provider }: PlanUsageSectionProps) {
  const { t } = useTranslation('chat');
  // Advance the displayed age/countdown while open without querying usage again.
  const [clockMs, setClockMs] = useState(() => performance.now());
  useEffect(() => {
    const clock = window.setInterval(() => setClockMs(performance.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);
  // Keep the last successful result while the user refreshes the panel.
  const [snapshot, setSnapshot] = useState<PlanUsageSnapshot | null>(() => lastSuccessfulUsage.get(provider ?? '') ?? null);
  // Disable overlapping refresh clicks and show progress.
  const [loading, setLoading] = useState(false);
  // Distinguish transport failures from a CLI that cannot report subscription usage.
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (forceRefresh = false) => {
    if (!provider || !PROVIDERS_WITH_PLAN_USAGE.has(provider)) {
      return;
    }
    setLoading(true);
    setFailed(false);
    try {
      const response = await api.providers.planUsage(provider, forceRefresh);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json() as { data?: PlanUsageData };
      if (!payload.data || !Array.isArray(payload.data.windows)) {
        throw new Error('Missing usage data');
      }
      // fetchedAt and resetsAt use the server clock. Comparing them to the
      // device clock can turn a fresh query into '59 minutes ago'. Keep the
      // response's server time with the cached result, then advance monotonically.
      const responseTimeMs = Date.parse(response.headers.get('Date') ?? '');
      const receivedAtMs = performance.now();
      const next = { data: payload.data, receivedAtMs,
        serverTimeMs: Number.isFinite(responseTimeMs) ? responseTimeMs : Date.now() };
      if (payload.data.status === 'ok') lastSuccessfulUsage.set(provider, next);
      setClockMs(receivedAtMs);
      setSnapshot(next);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    setSnapshot(lastSuccessfulUsage.get(provider ?? '') ?? null);
    void load();
  }, [load, provider]);

  if (!provider || !PROVIDERS_WITH_PLAN_USAGE.has(provider)) {
    return null;
  }

  const data = snapshot?.data;
  const nowMs = snapshot
    ? snapshot.serverTimeMs + Math.max(0, clockMs - snapshot.receivedAtMs)
    : 0;
  const windowLabel = (window: PlanUsageWindow) => {
    if (KNOWN_WINDOW_IDS.has(window.id)) {
      return t(`planUsage.windows.${window.id}`);
    }
    return window.windowMinutes
      ? t('planUsage.windows.generic', { hours: Math.round(window.windowMinutes / 60) })
      : t('planUsage.windows.unknown');
  };
  const durationText = (deltaMs: number) => {
    const { unit, count } = formatDuration(deltaMs);
    return t(`planUsage.duration.${unit}`, { count });
  };

  const fetchedAgeMs = data?.fetchedAt ? nowMs - Date.parse(data.fetchedAt) : 0;
  const fetchedAgeText = fetchedAgeMs < 60_000
    ? t('planUsage.justNow')
    : t('planUsage.ago', { duration: durationText(Math.floor(Math.max(0, fetchedAgeMs) / 60_000) * 60_000) });

  const unavailableMessage = failed
    ? t('planUsage.loadFailed')
    : data && data.status !== 'ok'
      ? (t(`planUsage.status.${data.status}`, { defaultValue: data.message || t('planUsage.loadFailed') }) || t('planUsage.loadFailed'))
      : null;

  return (
    <div className="rounded-2xl border border-border/70 bg-background/75 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <Gauge className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{t('planUsage.title')}</p>
            {data?.planName && (
              <p className="truncate text-xs text-muted-foreground">
                {t('planUsage.plan', { name: data.planName })}
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          aria-label={t('planUsage.refresh')}
          title={t('planUsage.refresh')}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4${loading ? ' animate-spin' : ''}`} />
        </button>
      </div>

      {loading && !data && (
        <p className="mt-3 text-xs text-muted-foreground">{t('planUsage.loading')}</p>
      )}

      {unavailableMessage && (
        <p className="mt-3 text-xs text-muted-foreground">{unavailableMessage}</p>
      )}

      {data?.status === 'ok' && (
        <div className="mt-4 space-y-3">
          {data.windows.map((window) => {
            const percent = Math.min(100, Math.max(0, window.usedPercent));
            const resetMs = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
            return (
              <div key={window.id}>
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="font-medium text-foreground">{windowLabel(window)}</span>
                  <span className="font-mono text-foreground">{Math.round(percent)}%</span>
                </div>
                <div
                  className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label={windowLabel(window)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(percent)}
                >
                  <div
                    className={`h-full rounded-full transition-all ${barToneClass(percent)}`}
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {Number.isFinite(resetMs) ? (
                    <>
                      {t('planUsage.resetsIn', { duration: durationText(resetMs - nowMs) })}
                      {' · '}
                      <time dateTime={window.resetsAt!}>{RESET_TIME_FORMAT.format(resetMs)} UTC+8</time>
                    </>
                  ) : t('planUsage.windowReset')}
                </p>
              </div>
            );
          })}

          {data.credits && (
            <p className="text-xs text-muted-foreground">
              {data.credits.unlimited
                ? t('planUsage.creditsUnlimited')
                : data.credits.balance !== null
                  ? t('planUsage.credits', { balance: Number(data.credits.balance).toLocaleString(undefined, { maximumFractionDigits: 2 }) })
                  : null}
            </p>
          )}

          {data.source === 'session-log' && data.message && (
            <p className="text-xs text-muted-foreground">{t('planUsage.cachedFallback')}</p>
          )}
          {data.fetchedAt && (
            <p className="text-[11px] text-muted-foreground/80">
              {data.source === 'cli'
                ? t(provider === 'codex' ? 'planUsage.updatedFromCodexCli' : 'planUsage.updatedFromCli', { duration: fetchedAgeText })
                : data.source === 'session-log'
                ? t('planUsage.updatedFromSession', { duration: fetchedAgeText })
                : t('planUsage.updatedLive')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
