import type { Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AnyRecord } from '@/shared/index.js';
import { AppError } from '@/shared/index.js';
import { queryCodexPlanUsage } from '@/modules/providers/services/codex-plan-query.service.js';
import { queryClaudePlanUsage } from '@/modules/providers/services/claude-plan-query.service.js';

type PlanUsageWindow = {
  id: string;
  /** Length of the rate-limit window in minutes, when the provider reports it. */
  windowMinutes: number | null;
  usedPercent: number;
  /** ISO timestamp at which the window resets, or null when unknown. */
  resetsAt: string | null;
};

type PlanUsageStatus = 'ok' | 'unauthenticated' | 'token-expired' | 'unsupported' | 'timeout' | 'error';

type PlanUsageResult = {
  provider: string;
  status: PlanUsageStatus;
  planName: string | null;
  windows: PlanUsageWindow[];
  credits: { balance: string | null; unlimited: boolean } | null;
  /** CLI control response for live queries, transcript event only as a Codex fallback. */
  source: 'cli' | 'session-log' | null;
  /** ISO timestamp of the completed live query, or the original logged event on fallback. */
  fetchedAt: string | null;
  message?: string;
};

type FileTail = { content: string; isComplete: boolean };

type ProviderPlanUsageServiceDependencies = {
  getHomeDirectory: () => string;
  now: () => number;
  queryClaudeUsage: typeof queryClaudePlanUsage;
  queryCodexUsage: typeof queryCodexPlanUsage;
  readTextFileTail: (filePath: string, maxBytes: number) => Promise<FileTail>;
  readDirectory: (directoryPath: string) => Promise<Dirent[]>;
  statMtimeMs: (filePath: string) => Promise<number>;
};

const CODEX_LOG_TAIL_BYTES = 1024 * 1024;
const PLAN_USAGE_CACHE_MS = 5 * 60_000;
/** How many of the newest Codex session files are searched for a rate-limit snapshot. */
const CODEX_MAX_FILES_SCANNED = 8;

/** Display order for the Claude CLI quota windows. */
const CLAUDE_WINDOWS: Array<{ key: string; id: string; windowMinutes: number }> = [
  { key: 'five_hour', id: 'five_hour', windowMinutes: 300 },
  { key: 'seven_day', id: 'weekly', windowMinutes: 10_080 },
  { key: 'seven_day_opus', id: 'weekly_opus', windowMinutes: 10_080 },
  { key: 'seven_day_sonnet', id: 'weekly_sonnet', windowMinutes: 10_080 },
];

const defaultDependencies: ProviderPlanUsageServiceDependencies = {
  getHomeDirectory: () => os.homedir(),
  now: () => Date.now(),
  queryClaudeUsage: queryClaudePlanUsage,
  queryCodexUsage: queryCodexPlanUsage,
  readTextFileTail: async (filePath, maxBytes) => {
    const handle = await fsp.open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      if (size <= maxBytes) {
        return { content: await handle.readFile({ encoding: 'utf8' }), isComplete: true };
      }

      const buffer = Buffer.alloc(maxBytes);
      await handle.read(buffer, 0, maxBytes, size - maxBytes);
      const content = buffer.toString('utf8');
      // Drop the partial first row (and any split multi-byte character with it).
      const firstNewline = content.indexOf('\n');
      return {
        content: firstNewline === -1 ? '' : content.slice(firstNewline + 1),
        isComplete: false,
      };
    } finally {
      await handle.close();
    }
  },
  readDirectory: (directoryPath) => fsp.readdir(directoryPath, { withFileTypes: true }),
  statMtimeMs: async (filePath) => (await fsp.stat(filePath)).mtimeMs,

};

function emptyResult(provider: string, status: PlanUsageStatus, message?: string): PlanUsageResult {
  return {
    provider,
    status,
    planName: null,
    windows: [],
    credits: null,
    source: null,
    fetchedAt: null,
    ...(message ? { message } : {}),
  };
}

function readFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function toIsoFromEpochSeconds(value: unknown): string | null {
  const seconds = readFiniteNumber(value);
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

function toIsoFromDateLike(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** "pro" -> "Pro", "max_5x" -> "Max 5x". */
function formatPlanName(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }
  return raw
    .trim()
    .split(/[_\s-]+/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/**
 * Used by the usage service/tests to normalize the CLI usage response windows.
 * Expired windows are omitted: a stale snapshot cannot prove the new usage is 0%.
 */
export function parseClaudeUsageBody(body: unknown, nowMs: number): PlanUsageWindow[] {
  if (!body || typeof body !== 'object') {
    return [];
  }

  const record = body as AnyRecord;
  const windows: PlanUsageWindow[] = [];
  for (const definition of CLAUDE_WINDOWS) {
    const entry = record[definition.key];
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const utilization = (entry as AnyRecord).utilization;
    const resetValue = (entry as AnyRecord).resets_at;
    const resetMs = typeof resetValue === 'string' ? Date.parse(resetValue) : NaN;
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)
      || !Number.isFinite(resetMs) || resetMs <= nowMs || resetMs > 8.64e15) {
      continue;
    }
    windows.push({
      id: definition.id,
      windowMinutes: definition.windowMinutes,
      usedPercent: clampPercent(utilization),
      resetsAt: new Date(resetMs).toISOString(),
    });
  }
  return windows;
}

/**
 * Used by this service and its tests to map Codex token_count rate_limits events.
 * A window whose reset time has already passed is reported as 0% used: the
 * logged percentage describes the old window.
 */
export function parseCodexRateLimits(
  rateLimits: AnyRecord,
  loggedAt: string | null,
  nowMs: number,
): PlanUsageResult {
  const windows: PlanUsageWindow[] = [];
  for (const [slot, id] of [['primary', 'primary'], ['secondary', 'secondary']] as const) {
    const entry = rateLimits[slot];
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const used = readFiniteNumber((entry as AnyRecord).used_percent);
    if (used === null) {
      continue;
    }
    const windowMinutes = readFiniteNumber((entry as AnyRecord).window_minutes);
    const resetsAt = toIsoFromEpochSeconds((entry as AnyRecord).resets_at);
    const expired = resetsAt !== null && Date.parse(resetsAt) <= nowMs;
    windows.push({
      id: windowMinutes === 10_080 ? 'weekly' : windowMinutes === 300 ? 'five_hour' : id,
      windowMinutes,
      usedPercent: expired ? 0 : clampPercent(used),
      resetsAt: expired ? null : resetsAt,
    });
  }

  const credits = rateLimits.credits && typeof rateLimits.credits === 'object'
    ? rateLimits.credits as AnyRecord
    : null;

  return {
    provider: 'codex',
    status: 'ok',
    planName: formatPlanName(rateLimits.plan_type),
    windows,
    credits: credits
      ? {
          balance: typeof credits.balance === 'string' || typeof credits.balance === 'number'
            ? String(credits.balance)
            : null,
          unlimited: credits.unlimited === true,
        }
      : null,
    source: 'session-log',
    fetchedAt: loggedAt,
  };
}

/** Used by the provider route singleton and isolated usage tests. */
export function createProviderPlanUsageService(
  overrides: Partial<ProviderPlanUsageServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };
  // Reopening the panel shares successful results for five minutes after completion.
  let claudeCache: { result: PlanUsageResult; expiresAt: number } | null = null;
  // Concurrent cache misses share one CLI process.
  let claudeInFlight: Promise<PlanUsageResult> | null = null;
  async function fetchClaudePlanUsage(): Promise<PlanUsageResult> {
    try {
      const usage = await dependencies.queryClaudeUsage();
      const windows = parseClaudeUsageBody(usage.rate_limits, dependencies.now());
      return {
        ...emptyResult('claude', usage.rate_limits_available && windows.length ? 'ok' : 'unsupported'),
        planName: formatPlanName(usage.subscription_type),
        windows: usage.rate_limits_available ? windows : [],
        source: 'cli',
        fetchedAt: new Date(dependencies.now()).toISOString(),
      };
    } catch (error) {
      // Do not surface CLI stderr or credential-related errors verbatim to the UI.
      return emptyResult('claude', error instanceof AppError && error.code === 'CLAUDE_USAGE_TIMEOUT' ? 'timeout' : 'error');
    }
  }
  function getClaudePlanUsage(forceRefresh: boolean): Promise<PlanUsageResult> {
    if (!forceRefresh && claudeCache && dependencies.now() < claudeCache.expiresAt) {
      return Promise.resolve(claudeCache.result);
    }
    claudeCache = null;
    claudeInFlight ??= fetchClaudePlanUsage()
      .then(result => {
        if (result.status === 'ok') {
          claudeCache = { result, expiresAt: dependencies.now() + PLAN_USAGE_CACHE_MS };
        }
        return result;
      })
      .finally(() => { claudeInFlight = null; });
    return claudeInFlight;
  }

  // Codex uses the same five-minute policy, but only live results enter cache.
  let codexCache: { result: PlanUsageResult; expiresAt: number } | null = null;
  let codexInFlight: Promise<PlanUsageResult> | null = null;
  function getLiveCodexPlanUsage(forceRefresh: boolean): Promise<PlanUsageResult> {
    if (!forceRefresh && codexCache && dependencies.now() < codexCache.expiresAt) return Promise.resolve(codexCache.result);
    codexCache = null;
    codexInFlight ??= (async () => {
      try {
        const limits = await dependencies.queryCodexUsage();
        const now = dependencies.now();
        const result = parseCodexRateLimits(limits, new Date(now).toISOString(), now);
        if (!result.windows.length) throw new Error('Codex returned no quota windows.');
        result.source = 'cli';
        codexCache = { result, expiresAt: now + PLAN_USAGE_CACHE_MS };
        return result;
      } catch (error) {
        const fallback = await getCodexPlanUsage();
        if (fallback.status === 'ok') return { ...fallback, message: 'Live quota query failed; showing the last recorded session data.' };
        return emptyResult('codex', error instanceof AppError && error.code === 'CODEX_USAGE_TIMEOUT' ? 'timeout' : 'error');
      }
    })().finally(() => { codexInFlight = null; });
    return codexInFlight;
  }

  /** Session files newest-first by mtime, walking the date-partitioned tree. */
  async function listCodexSessionFiles(directoryPath: string): Promise<Array<{ file: string; mtimeMs: number }>> {
    let entries: Dirent[];
    try {
      entries = await dependencies.readDirectory(directoryPath);
    } catch {
      return [];
    }

    const files: Array<{ file: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...await listCodexSessionFiles(entryPath));
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          files.push({ file: entryPath, mtimeMs: await dependencies.statMtimeMs(entryPath) });
        } catch {
          // The file vanished between listing and stat.
        }
      }
    }
    return files;
  }

  async function getCodexPlanUsage(): Promise<PlanUsageResult> {
    const sessionsRoot = path.join(dependencies.getHomeDirectory(), '.codex', 'sessions');
    const files = (await listCodexSessionFiles(sessionsRoot))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, CODEX_MAX_FILES_SCANNED);

    if (files.length === 0) {
      return emptyResult('codex', 'unsupported', 'No Codex session has recorded usage limits yet.');
    }

    for (const { file } of files) {
      let tail: FileTail;
      try {
        tail = await dependencies.readTextFileTail(file, CODEX_LOG_TAIL_BYTES);
      } catch {
        continue;
      }

      const lines = tail.content.split('\n');
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index].includes('"rate_limits"')) {
          continue;
        }
        try {
          const entry = JSON.parse(lines[index]) as AnyRecord;
          const rateLimits = entry.payload?.rate_limits;
          if (entry.payload?.type === 'token_count' && rateLimits && typeof rateLimits === 'object') {
            const result = parseCodexRateLimits(
              rateLimits as AnyRecord,
              toIsoFromDateLike(entry.timestamp),
              dependencies.now(),
            );
            if (result.windows.length > 0) {
              return result;
            }
          }
        } catch {
          // The last line may still be mid-write.
        }
      }
    }

    return emptyResult('codex', 'unsupported', 'No Codex session has recorded usage limits yet.');
  }

  return {
    async getPlanUsage(provider: string, { forceRefresh = false } = {}): Promise<PlanUsageResult> {
      if (provider === 'claude') {
        return getClaudePlanUsage(forceRefresh);
      }
      if (provider === 'codex') {
        return getLiveCodexPlanUsage(forceRefresh);
      }
      if (provider === 'cursor' || provider === 'opencode') {
        return emptyResult(provider, 'unsupported', 'Plan usage is not available for this provider.');
      }
      throw new AppError(`Unsupported provider "${provider}".`, {
        code: 'UNSUPPORTED_PROVIDER',
        statusCode: 400,
      });
    },
  };
}

/** Used by Providers routes to serve CLI quota data. */
export const providerPlanUsageService = createProviderPlanUsageService();
