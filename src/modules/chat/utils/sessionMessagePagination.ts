import type { NormalizedMessage } from '@/shared/types';

type LatestPageMergeResult = {
  messages: NormalizedMessage[];
  overlapLength: number;
};

type OlderPageMergeResult = {
  messages: NormalizedMessage[];
  overlapLength: number;
  prependedCount: number;
};

// The unified session-history URL is declared with the rest of the endpoints;
// it is re-exported here because the pagination tests cover its shape.
export { sessionMessagesUrl as buildSessionMessagesUrl } from '@/shared/api';

function serializedValue(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Persisted IDs are preferred, but some provider readers (notably Codex)
 * generate fresh IDs on every read. The fallback uses stable transcript fields
 * and deliberately excludes enrichment such as toolResult, which may change
 * when the provider finishes writing a turn.
 */
function messagesRepresentSamePersistedRow(
  first: NormalizedMessage,
  second: NormalizedMessage,
): boolean {
  if (first.provider !== second.provider) return false;
  if (first.messageKey && second.messageKey) return first.messageKey === second.messageKey;
  if (first.id === second.id) return true;
  if (
    first.kind !== second.kind
    || first.timestamp !== second.timestamp
    || first.role !== second.role
  ) {
    return false;
  }

  if (first.toolId || second.toolId) return first.toolId === second.toolId;
  if (first.rowid !== undefined || second.rowid !== undefined) return first.rowid === second.rowid;
  if (first.sequence !== undefined || second.sequence !== undefined) return first.sequence === second.sequence;

  return (
    (first.content ?? '') === (second.content ?? '')
    && (first.text ?? '') === (second.text ?? '')
    && (first.toolName ?? '') === (second.toolName ?? '')
    && (first.commandName ?? '') === (second.commandName ?? '')
    && (first.parentToolUseId ?? '') === (second.parentToolUseId ?? '')
    && serializedValue(first.toolInput) === serializedValue(second.toolInput)
  );
}

/**
 * How many cached rows the latest window supersedes: everything from the
 * cached copy of the window's first row onwards. Zero when the window starts
 * after the cache ends (a gap) or is unrelated to it. Searched from the newest
 * cached row back so a repeated row resolves to its most recent occurrence.
 */
export function findLatestPageOverlapLength(
  cachedMessages: NormalizedMessage[],
  latestMessages: NormalizedMessage[],
): number {
  const first = latestMessages[0];
  if (!first) return 0;
  for (let index = cachedMessages.length - 1; index >= 0; index--) {
    if (messagesRepresentSamePersistedRow(cachedMessages[index], first)) return cachedMessages.length - index;
  }
  return 0;
}

/**
 * Atomically replaces the overlapping cached tail with the latest persisted
 * window while retaining every already-loaded older row.
 */
export function mergeLatestServerPage(
  cachedMessages: NormalizedMessage[],
  latestMessages: NormalizedMessage[],
): LatestPageMergeResult {
  if (cachedMessages.length === 0) {
    return { messages: latestMessages, overlapLength: 0 };
  }
  if (latestMessages.length === 0) {
    return { messages: cachedMessages, overlapLength: 0 };
  }

  const overlapLength = findLatestPageOverlapLength(cachedMessages, latestMessages);
  if (overlapLength === 0) {
    return { messages: cachedMessages, overlapLength: 0 };
  }

  return {
    messages: [
      ...cachedMessages.slice(0, cachedMessages.length - overlapLength),
      ...latestMessages,
    ],
    overlapLength,
  };
}

/**
 * Reconciles a tail-offset older-page response with the cached suffix when the
 * transcript grew while that request was in flight. With no overlap the page
 * is treated as the normal immediately-preceding page.
 */
export function mergeOlderServerPage(
  cachedMessages: NormalizedMessage[],
  olderMessages: NormalizedMessage[],
): OlderPageMergeResult {
  const maximum = Math.min(cachedMessages.length, olderMessages.length);
  let overlapLength = 0;

  for (let length = maximum; length > 0; length--) {
    const olderStart = olderMessages.length - length;
    let matches = true;
    for (let index = 0; index < length; index++) {
      if (!messagesRepresentSamePersistedRow(olderMessages[olderStart + index], cachedMessages[index])) {
        matches = false;
        break;
      }
    }
    if (matches) {
      overlapLength = length;
      break;
    }
  }

  const prependedCount = olderMessages.length - overlapLength;
  return {
    messages: [
      ...olderMessages.slice(0, prependedCount),
      ...cachedMessages,
    ],
    overlapLength,
    prependedCount,
  };
}
