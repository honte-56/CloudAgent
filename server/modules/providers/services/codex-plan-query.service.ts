import { CodexLiveClient } from '@/modules/providers/list/codex/codex-live.client.js';
import { AppError } from '@/shared/index.js';
import type { AnyRecord } from '@/shared/index.js';

type UsageClient = Pick<CodexLiveClient, 'initialize' | 'call' | 'close'>;

/** Providers' usage service queries the logged-in Codex account without starting a thread or model turn. */
export async function queryCodexPlanUsage(options: {
  createClient?: () => UsageClient;
  timeoutMs?: number;
} = {}): Promise<AnyRecord> {
  const client = options.createClient?.() ?? new CodexLiveClient(() => {}, () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.initialize();
        const response = await client.call('account/rateLimits/read', {});
        const limits = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
        if (!limits || typeof limits !== 'object') throw new AppError('Codex quota is unavailable.', { code: 'CODEX_USAGE_UNAVAILABLE', statusCode: 503 });
        const window = (value: AnyRecord | null | undefined) => value && typeof value === 'object' ? {
          used_percent: value.usedPercent, window_minutes: value.windowDurationMins, resets_at: value.resetsAt,
        } : null;
        return { plan_type: limits.planType, credits: limits.credits,
          primary: window(limits.primary), secondary: window(limits.secondary) };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AppError('Codex usage query timed out.', {
          code: 'CODEX_USAGE_TIMEOUT', statusCode: 504,
        })), options.timeoutMs ?? 20_000);
      }),
    ]);
  } finally { clearTimeout(timer); client.close(); }
}
