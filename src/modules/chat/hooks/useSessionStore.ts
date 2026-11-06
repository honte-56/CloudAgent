/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by sessionId.
 * Session switch = change activeSessionId pointer. No clearing. Old data stays.
 * WebSocket handler = store.appendRealtime(msg.sessionId, msg). One line.
 * No localStorage for messages. Backend JSONL is the source of truth.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { stripRuntimeInstructions } from '@/shared/utils';
import type { LLMProvider, NormalizedMessage } from '@/shared/types';
import { removeOptimisticUserEchoes } from '@/modules/chat/utils/sessionMessageReconciliation';
import {
  hasReachedCachedTailTimeBoundary,
  mergeLatestServerPage,
  mergeOlderServerPage,
  planLatestPageBridge,
  resolveLatestPagePagination,
  SESSION_MESSAGES_PAGE_SIZE,
} from '@/modules/chat/utils/sessionMessagePagination';
import type { SessionMessagesRequestOptions } from '@/modules/chat/utils/sessionMessagePagination';

// ─── NormalizedMessage (mirrors server/adapters/types.js) ────────────────────


// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export type SessionSlot = {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  merged: NormalizedMessage[];
  /** @internal Cache-invalidation refs for computeMerged */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  _lastHasMore: boolean;
  /**
   * @internal Serializes history reads for this session so an older-page
   * request calculates its offset after any latest-page refresh completes.
   */
  _historyMutationQueue: Promise<void>;
  /** Retain ordering anchors when persisted rows replace their live copies. */
  _deliveryPositions: Map<string, number>;
  status: SessionStatus;
  fetchedAt: number;
  /** Last live update, allowing the visible pane to avoid redundant file polling while streaming. */
  lastRealtimeAt?: number;
  total: number;
  hasMore: boolean;
  offset: number;
  /** Stable oldest loaded identity used by the history cursor API. */
  oldestCursor?: string;
  timelineRevision?: number;
  tokenUsage: unknown;
};

const EMPTY: NormalizedMessage[] = [];
const SESSION_HISTORY_REQUEST_TIMEOUT_MS = 30_000;

function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    _lastHasMore: false,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    // `undefined` means "no page has reported usage for this session yet", and
    // every consumer distinguishes that from a reported `null`. Initialising it
    // to `null` made the two indistinguishable, so a provider whose history
    // payload carries no usage looked like one reporting zero — and every
    // history refresh overwrote the value fetched from the token-usage
    // endpoint with it.
    tokenUsage: undefined,
    _historyMutationQueue: Promise.resolve(),
    _deliveryPositions: new Map(),
  };
}

type SessionHistoryPage = {
  oldestCursor?: string;
  timelineRevision?: number;
  messages: NormalizedMessage[];
  total: number;
  hasMore: boolean;
  tokenUsage?: unknown;
};

function enqueueHistoryMutation<T>(
  slot: SessionSlot,
  operation: () => Promise<T>,
): Promise<T> {
  const result = slot._historyMutationQueue.then(operation);
  slot._historyMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// Only provider-owned rows carry injected context. Local composer text must
// remain byte-for-byte intact, including a user quoting the instruction text.
function cleanProviderUserMessage(row: NormalizedMessage): NormalizedMessage {
  if (row.kind !== 'text' || row.role !== 'user' || row.id.startsWith('local_') || row.runtimeContextStripped || typeof row.content !== 'string') return row;
  return { ...row, content: stripRuntimeInstructions(row.content), runtimeContextStripped: true };
}

async function requestSessionHistoryPage(
  sessionId: string,
  options: SessionMessagesRequestOptions,
): Promise<SessionHistoryPage> {
  const response = await api.providers.sessionMessages(sessionId, options, {
    signal: AbortSignal.timeout(SESSION_HISTORY_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body = await response.json();
  const data = body?.data ?? body;
  const messages: NormalizedMessage[] = (Array.isArray(data.messages) ? data.messages : []).map(cleanProviderUserMessage);

  return {
    messages,
    oldestCursor: data.oldestCursor,
    timelineRevision: data.timelineRevision,
    total: typeof data.total === 'number' ? data.total : messages.length,
    hasMore: Boolean(data.hasMore),
    ...(
      data && typeof data === 'object' && 'tokenUsage' in data
        ? { tokenUsage: data.tokenUsage }
        : {}
    ),
  };
}

/**
 * Compute merged messages: server + realtime, deduped by id and adjacent
 * assistant echo (same trimmed text), so finalized stream rows do not stack
 * on top of the persisted copy before realtime is cleared.
 */
function readMessageTime(m: NormalizedMessage): number | null {
  const time = Date.parse(m.timestamp);
  return Number.isFinite(time) ? time : null;
}

function compareMessagesChronologically(a: NormalizedMessage, b: NormalizedMessage): number {
  const timeA = readMessageTime(a) ?? 0;
  const timeB = readMessageTime(b) ?? 0;
  if (timeA !== timeB) {
    return timeA - timeB;
  }
  return 0;
}

/**
 * The time a row sorts by, which is its own except for one case.
 *
 * The optimistic echo of an edited message is the row whose clock cannot be
 * trusted against the rows around it. Providers that rewind by branching —
 * Codex has no way to resume a transcript partway, so an edit copies the kept
 * history into a new one — write the copy with the timestamps of the copy. So
 * every turn that survived the cut comes back from the next refresh stamped a
 * moment *after* the replacement was typed, and the message the user just sent
 * jumps to the top of the conversation.
 *
 * A replacement is by definition the newest thing in the conversation, so it
 * is sorted as such instead of by what the clock said when it was typed.
 */

/**
 * Count how many user turns precede `message` in a chronologically merged view
 * of server + realtime rows. Used to match a realtime row to the correct turn
 * on disk when several turns share identical assistant text.
 */
function getUserTurnOrdinalBefore(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): number {
  const messageTime = readMessageTime(message);
  let userCount = 0;

  for (const candidate of [...serverMessages, ...realtimeMessages].sort(compareMessagesChronologically)) {
    if (candidate.id === message.id) {
      break;
    }

    const candidateTime = readMessageTime(candidate);
    if (
      messageTime !== null
      && candidateTime !== null
      && candidateTime > messageTime
    ) {
      break;
    }

    if (candidate.kind === 'text' && candidate.role === 'user') {
      userCount++;
    }
  }

  return Math.max(0, userCount - 1);
}

function findServerTurnRangeByOrdinal(
  serverMessages: NormalizedMessage[],
  turnOrdinal: number,
): { start: number; end: number } | null {
  let userCount = -1;
  let start = -1;

  for (let index = 0; index < serverMessages.length; index++) {
    const message = serverMessages[index];
    if (message.kind === 'text' && message.role === 'user') {
      userCount++;
      if (userCount === turnOrdinal) {
        start = index;
        break;
      }
    }
  }

  if (start < 0) {
    return null;
  }

  let end = serverMessages.length;
  for (let index = start + 1; index < serverMessages.length; index++) {
    if (serverMessages[index].kind === 'text' && serverMessages[index].role === 'user') {
      end = index;
      break;
    }
  }

  return { start, end };
}

function isAssistantTextEchoedInSameTurnOnServer(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): boolean {
  const assistantText = (message.content || '').trim();
  if (!assistantText) {
    return false;
  }

  const turnOrdinal = getUserTurnOrdinalBefore(message, serverMessages, realtimeMessages);
  const turnRange = findServerTurnRangeByOrdinal(serverMessages, turnOrdinal);
  if (!turnRange) {
    return false;
  }

  return serverMessages
    .slice(turnRange.start + 1, turnRange.end)
    .some((serverMessage) =>
      serverMessage.kind === 'text'
      && serverMessage.role === 'assistant'
      && (serverMessage.content || '').trim() === assistantText,
    );
}

/**
 * After `finalizeStreaming`, the client holds a synthetic assistant `text` row
 * while the sessions API soon returns the same reply with a different id.
 * Those sit back-to-back in merged order and look like duplicate bubbles until
 * A persisted-tail refresh reconciles realtime. Collapse same-text assistant rows and
 * stream_placeholder → text when content matches.
 */
function dedupeAdjacentAssistantEchoes(merged: NormalizedMessage[]): NormalizedMessage[] {
  const indexes = new Map<string, number>();
  const out: NormalizedMessage[] = [];
  for (const message of merged) {
    const key = message.messageKey || `${message.kind}:${message.id}`;
    const index = indexes.get(key);
    if (index === undefined) { indexes.set(key, out.length); out.push(message); }
    else {
      const previous = out[index];
      // A late partial snapshot must never replace the authoritative completed item.
      if (message.kind === 'stream_delta' && previous.kind === 'text'
        && (previous.content?.length ?? 0) >= (message.content?.length ?? 0)) continue;
      out[index] = { ...message, timestamp: previous.timestamp, firstSeq: previous.firstSeq ?? message.firstSeq };
    }
  }
  return out;
}

/**
 * After a server refresh, drop only the realtime rows the persisted transcript
 * already owns. Anything not yet on disk (common right after `complete`, while
 * JSONL indexing lags) stays in `realtimeMessages` so the chat pane never
 * flashes the empty "Continue your conversation" state.
 */
// Earlier Claude adapters restarted the block index for every JSONL row.
// Repair those cached/replayed aliases only within the same native API response;
// matching by text across responses would erase legitimate repeated replies.
function reconcileClaudeBlockAliases(
  persisted: NormalizedMessage[], live: NormalizedMessage[], positions?: Map<string, number>,
): NormalizedMessage[] {
  const responseId = (row: NormalizedMessage) => row.provider === 'claude'
    ? /^claude(?:-block)?:([^:]+):\d+$/.exec(row.messageKey || row.id)?.[1] : undefined;
  const canonical = [...new Map(persisted.map(row => [timelineIdentity(row), row])).values()];
  return live.map(row => {
    if (row.provider !== 'claude' || (row.messageKey || row.id).startsWith('claude-block:')) return row;
    const response = responseId(row);
    const candidates = canonical.filter(candidate => {
      if (candidate.provider !== 'claude') return false;
      if (row.kind === 'tool_use') return candidate.kind === 'tool_use' && Boolean(row.toolId) && row.toolId === candidate.toolId;
      if (!response || responseId(candidate) !== response || !row.content || !candidate.content) return false;
      if (row.kind === 'thinking') return candidate.kind === 'thinking' && candidate.content === row.content;
      if (candidate.kind !== 'text' || candidate.role !== 'assistant' || (row.kind !== 'stream_delta' && !(row.kind === 'text' && row.role === 'assistant'))) return false;
      return candidate.content === row.content || row.kind === 'stream_delta'
        && (candidate.content.startsWith(row.content) || row.content.startsWith(candidate.content));
    });
    if (candidates.length !== 1) return row;
    const target = candidates[0];
    if (target.id === row.id && target.messageKey === row.messageKey) return row;
    const position = row.firstSeq ?? row.seq;
    if (positions && position !== undefined) {
      const key = timelineIdentity(target);
      positions.set(key, Math.min(positions.get(key) ?? position, position));
    }
    return { ...row, id: target.id, messageKey: target.messageKey };
  });
}

function pruneRealtimeSupersededByServer(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  positions?: Map<string, number>,
): NormalizedMessage[] {
  realtimeMessages = reconcileClaudeBlockAliases(serverMessages, realtimeMessages, positions);
  if (realtimeMessages.length === 0) {
    return realtimeMessages;
  }

  const serverIds = new Set(serverMessages.map((message) => message.id));
  const reconciledRealtimeMessages = removeOptimisticUserEchoes(serverMessages, realtimeMessages);

  return reconciledRealtimeMessages.filter((message) => {
    const persisted = serverMessages.find(row => message.messageKey && row.messageKey === message.messageKey);
    if (persisted) {
      if (persisted.content === message.content || (message.kind === 'stream_delta' && persisted.content?.startsWith(message.content || ''))) return false;
      return true;
    }
    if (serverIds.has(message.id)) {
      return false;
    }

    if (message.kind === 'stream_delta' || message.id === `__streaming_${message.sessionId}`) {
      if ((!message.messageKey || message.messageKey.startsWith('legacy:')) && isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'assistant') {
      if ((!message.messageKey || message.messageKey.startsWith('legacy:')) && isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'user') {
      return true;
    }

    if (message.kind === 'tool_use' && message.toolId) {
      if (serverMessages.some((serverMessage) => serverMessage.kind === 'tool_use' && serverMessage.toolId === message.toolId)) {
        return false;
      }
    }

    return true;
  });
}

function timelineIdentity(row: NormalizedMessage): string {
  return row.messageKey || (row.toolId ? `${row.kind}:${row.toolId}` : row.id);
}
function isLegacyControlSignal(row: NormalizedMessage): boolean {
  return row.provider === 'codex' && row.kind === 'tool_use' && (['subAgentActivity', 'SubAgentActivity'].includes(row.toolName || '')
    || row.toolName === 'TodoWrite' && (row.toolId || row.id).endsWith('-plan'));
}

function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[], positions: Map<string, number>, hasMore: boolean): NormalizedMessage[] {
  const identity = timelineIdentity;
  const rows = [...server];
  const indexes = new Map(server.map((row, index) => [identity(row), index]));
  const reconciled = removeOptimisticUserEchoes(server, reconcileClaudeBlockAliases(server, realtime, positions)).filter(row => !isLegacyControlSignal(row));
  // Compacted replay delivers a growing item's latest snapshot later than its
  // first fragment. Restore first-delivery order before interleaving history.
  const sequenced = reconciled.filter(row => typeof row.seq === 'number')
    .sort((a,b) => (a.firstSeq ?? a.seq!) - (b.firstSeq ?? b.seq!));
  let sequenceIndex = 0;
  const live = reconciled.map(row => typeof row.seq === 'number' ? sequenced[sequenceIndex++] : row);
  const nextAnchor: number[] = new Array(live.length);
  let next = server.length;
  for (let i = live.length - 1; i >= 0; i--) {
    const index = indexes.get(identity(live[i]));
    if (index !== undefined) next = index;
    nextAnchor[i] = next;
  }
  const persistedAnchors = server.flatMap((row, index) => {
    const sequence = positions.get(identity(row));
    return sequence === undefined ? [] : [{ index, sequence }];
  });
  const oldestPersistedSequence = persistedAnchors.length ? Math.min(...persistedAnchors.map(anchor => anchor.sequence)) : undefined;
  const buckets = new Map<number, NormalizedMessage[]>();
  let preceding = -1;
  let minimumSequencedInsertion = 0;
  for (let i = 0; i < live.length; i++) {
    const message = live[i], index = indexes.get(identity(message));
    if (index !== undefined) {
      preceding = index;
      if (message.seq !== undefined) minimumSequencedInsertion = Math.max(minimumSequencedInsertion, index + 1);
      const persisted = rows[index];
      if ((message.kind === 'stream_delta' && (message.content?.length ?? 0) > (persisted.content?.length ?? 0))
        || (message.messageKey && message.kind === 'text' && message.content !== persisted.content))
        rows[index] = { ...message, timestamp: persisted.timestamp };
      continue;
    }
    // Persisted order is authoritative. Live rows keep their delivery order
    // between shared anchors; provider/client clock skew cannot reshuffle it.
    let insertion = preceding >= 0 ? preceding + 1 : nextAnchor[i];
    const sequence = positions.get(identity(message));
    if (sequence !== undefined && persistedAnchors.length) {
      // A replay may include older turns outside the loaded history window.
      // Keep them in the store for upward paging, not after the newest answer.
      const firstRowPosition = server[0] ? positions.get(identity(server[0])) : undefined;
      const messageTime = readMessageTime(message), firstRowTime = server[0] ? readMessageTime(server[0]) : null;
      // The first matching anchor may follow unsequenced rows in the page.
      // It is not a safe cutoff for a pending command that began between them.
      const precedesWindow = firstRowPosition !== undefined ? sequence < firstRowPosition
        : oldestPersistedSequence !== undefined && sequence < oldestPersistedSequence
          && messageTime !== null && firstRowTime !== null && messageTime < firstRowTime;
      if (hasMore && precedesWindow) continue;
      const earlier = persistedAnchors.filter(anchor => anchor.sequence <= sequence);
      insertion = earlier.length ? Math.max(...earlier.map(anchor => anchor.index)) + 1 : 0;
      if (!earlier.length && firstRowPosition === undefined && messageTime !== null) {
        const firstAnchorIndex = Math.min(...persistedAnchors.map(anchor => anchor.index));
        const after = server.slice(0, firstAnchorIndex + 1).findIndex(row => (readMessageTime(row) ?? Infinity) > messageTime);
        insertion = after >= 0 ? after : firstAnchorIndex;
      }
      // History may already contain a new user prompt that was never echoed
      // through the journal. An old assistant anchor alone must not place the
      // first reply fragment before that prompt. Advance within the unsequenced
      // gap using native timestamps, never across a later delivery anchor.
      if (earlier.length && messageTime !== null) {
        const later = persistedAnchors.filter(anchor => anchor.sequence > sequence && anchor.index >= insertion);
        const boundary = later.length ? Math.min(...later.map(anchor => anchor.index)) : server.length;
        while (insertion < boundary && !positions.has(identity(server[insertion]))) {
          const time = readMessageTime(server[insertion]);
          if (time === null || time > messageTime) break;
          insertion++;
        }
      }
    }
    if (message.seq !== undefined) {
      insertion = Math.max(insertion, minimumSequencedInsertion);
      minimumSequencedInsertion = insertion;
    }
    if (!message.messageKey && !message.seq && !message.replacesAnchorId && preceding < 0 && insertion === server.length) {
      // Unsequenced legacy/local echoes have no server identity yet.
      const time = readMessageTime(message);
      const found = time === null ? -1 : server.findIndex(row => (readMessageTime(row) ?? 0) > time);
      if (found >= 0) insertion = found;
    }
    const bucket = buckets.get(insertion) ?? [];
    bucket.push(message); buckets.set(insertion, bucket);
  }
  const merged: NormalizedMessage[] = [];
  for (let i = 0; i <= rows.length; i++) {
    merged.push(...(buckets.get(i) ?? []));
    if (i < rows.length) merged.push(rows[i]);
  }
  return dedupeAdjacentAssistantEchoes(merged);
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef && slot.hasMore === slot._lastHasMore) {
    return false;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot._lastHasMore = slot.hasMore;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages, slot._deliveryPositions, slot.hasMore);
  return true;
}

type LatestHistoryRefreshResult = {
  applied: boolean;
  changed: boolean;
  deferred: boolean;
};

type CanRequestHistory = () => boolean;

// Token usage is JSON response data, so compare its serialized value instead
// of treating each freshly parsed response object as a state change.
function hasEquivalentTokenUsage(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

function olderPagePrecedesCachedHistory(
  olderMessages: NormalizedMessage[],
  cachedMessages: NormalizedMessage[],
): boolean {
  const olderNewest = olderMessages[olderMessages.length - 1];
  const cachedOldest = cachedMessages[0];
  if (!olderNewest || !cachedOldest) return true;

  const olderTime = readMessageTime(olderNewest);
  const cachedTime = readMessageTime(cachedOldest);
  return olderTime === null || cachedTime === null || olderTime <= cachedTime;
}

/**
 * Fetches and atomically applies a bounded persisted-tail reconciliation.
 * Every request is finite. Claude/Codex bridge discovery may use more than one
 * bounded chunk because their response `total` omits paginated tool results.
 */
async function refreshLatestSlotFromServer(
  sessionId: string,
  slot: SessionSlot,
  limit: number,
  canRequest: CanRequestHistory = () => true,
): Promise<LatestHistoryRefreshResult> {
  if (!canRequest()) {
    return { applied: false, changed: false, deferred: true };
  }

  let previousServerMessages = slot.serverMessages;
  const previousTotal = slot.total;
  let previousHasMore = slot.hasMore;
  const latestPage = await requestSessionHistoryPage(sessionId, {
    limit,
    offset: 0,
  });

  if (latestPage.timelineRevision !== undefined && latestPage.timelineRevision < (slot.timelineRevision ?? 0)) return { applied: false, changed: false, deferred: false };
  if ((latestPage.timelineRevision ?? 0) > (slot.timelineRevision ?? 0)) {
    slot.realtimeMessages = slot.realtimeMessages.filter(row => (row.seq ?? 0) >= latestPage.timelineRevision! || Boolean(row.replacesAnchorId));
    slot.timelineRevision = latestPage.timelineRevision;
    previousServerMessages = [];
    previousHasMore = latestPage.hasMore;
  }
  let nextServerMessages: NormalizedMessage[] | null = null;
  let nextHasMore = previousHasMore;

  // A page with no older rows is the complete authoritative transcript. This
  // also removes cached rows after a provider-side truncation.
  if (!latestPage.hasMore) {
    nextServerMessages = latestPage.messages;
    nextHasMore = false;
  } else if (previousServerMessages.length === 0) {
    nextServerMessages = latestPage.messages;
    nextHasMore = true;
  } else {
    let fetchedWindow = latestPage.messages;
    let oldestFetchedPage = latestPage;
    let bridgeRowsFetched = 0;
    let reachedStartOfHistory = false;
    let mergedPage = mergeLatestServerPage(previousServerMessages, fetchedWindow);

    while (
      mergedPage.overlapLength === 0
      && !hasReachedCachedTailTimeBoundary(previousServerMessages, fetchedWindow)
    ) {
      const bridgeRequest = planLatestPageBridge(
        previousServerMessages,
        latestPage.messages,
        previousTotal,
        latestPage.total,
        bridgeRowsFetched,
      );
      if (!bridgeRequest) break;
      if (!canRequest()) {
        return { applied: false, changed: false, deferred: true };
      }

      const bridgeCursor = oldestFetchedPage.oldestCursor;
      const bridgePage = await requestSessionHistoryPage(sessionId, bridgeCursor
        ? { limit, before: bridgeCursor } : bridgeRequest);
      if ((!bridgeCursor && bridgePage.total !== latestPage.total) || (bridgePage.timelineRevision ?? 0) !== (latestPage.timelineRevision ?? 0)) {
        console.warn(`[SessionStore] History changed while bridging ${sessionId}; retaining cached suffix.`);
        return { applied: false, changed: false, deferred: false };
      }
      if (bridgePage.messages.length === 0) break;

      const bridgeMerge = mergeOlderServerPage(fetchedWindow, bridgePage.messages);
      if (
        bridgeMerge.overlapLength > 0
        || !olderPagePrecedesCachedHistory(bridgePage.messages, fetchedWindow)
      ) {
        console.warn(`[SessionStore] History shifted while bridging ${sessionId}; retaining cached suffix.`);
        return { applied: false, changed: false, deferred: false };
      }

      fetchedWindow = bridgeMerge.messages;
      oldestFetchedPage = bridgePage;
      bridgeRowsFetched += bridgePage.messages.length;
      mergedPage = mergeLatestServerPage(previousServerMessages, fetchedWindow);

      if (!bridgePage.hasMore) {
        reachedStartOfHistory = true;
        break;
      }
    }

    if (reachedStartOfHistory) {
      nextServerMessages = fetchedWindow;
      nextHasMore = false;
    } else if (mergedPage.overlapLength > 0) {
      nextServerMessages = mergedPage.messages;
      nextHasMore = resolveLatestPagePagination(
        previousServerMessages.length,
        nextServerMessages.length,
        previousHasMore,
        oldestFetchedPage.hasMore,
      ).hasMore;
    }
  }

  let changed = false;
  if (
    latestPage.tokenUsage !== undefined
    && !hasEquivalentTokenUsage(latestPage.tokenUsage, slot.tokenUsage)
  ) {
    slot.tokenUsage = latestPage.tokenUsage;
    changed = true;
  }

  if (!nextServerMessages) {
    console.warn(`[SessionStore] Could not bridge latest history for ${sessionId}; retaining cached suffix.`);
    return { applied: false, changed, deferred: false };
  }

  // Retain unchanged row objects so periodic reconciliation does not reparse
  // settled Markdown or rebuild tools. Only the fetched tail normally differs.
  nextServerMessages = nextServerMessages.map((row, index) => {
    const previous = slot.serverMessages[index];
    return previous && (previous === row || (previous.id === row.id && JSON.stringify(previous) === JSON.stringify(row))) ? previous : row;
  });
  const sameRows = nextServerMessages.length === slot.serverMessages.length && nextServerMessages.every((row,index) => row === slot.serverMessages[index]);
  if (sameRows) nextServerMessages = slot.serverMessages;
  slot.serverMessages = nextServerMessages;
  slot.oldestCursor = nextServerMessages[0]?.messageKey || nextServerMessages[0]?.id;
  slot.total = latestPage.total;
  slot.offset = nextServerMessages.length;
  slot.hasMore = nextHasMore;
  slot.fetchedAt = Date.now();
  const remaining = pruneRealtimeSupersededByServer(slot.serverMessages, slot.realtimeMessages, slot._deliveryPositions);
  if (remaining.length !== slot.realtimeMessages.length || remaining.some((row,index) => row !== slot.realtimeMessages[index])) slot.realtimeMessages = remaining;
  changed = recomputeMergedIfNeeded(slot) || changed;

  return { applied: true, changed, deferred: false };
}

// ─── Stale threshold ─────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 30_000;

const MAX_REALTIME_MESSAGES = 500;

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore() {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const activeSessionIdRef = useRef<string | null>(null);
  // Bump to force re-render — only when the active session's data changes.
  // Session ids are stable for the whole conversation lifetime (the backend
  // allocates them before the first send), so slots are keyed directly with
  // no alias/redirect indirection.
  const [, setTick] = useState(0);
  const notify = useCallback((sessionId: string) => {
    if (sessionId === activeSessionIdRef.current) {
      setTick(n => n + 1);
    }
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
  }, []);

  const getSlot = useCallback((sessionId: string): SessionSlot => {
    const store = storeRef.current;
    if (!store.has(sessionId)) {
      store.set(sessionId, createEmptySlot());
    }
    return store.get(sessionId)!;
  }, []);

  /**
   * Fetch messages from the provider sessions endpoint and populate serverMessages.
   *
   * Provider and project metadata are resolved server-side from `sessionId`.
   * The endpoint returns the standard `{ success, data }` envelope.
   */
  const fetchFromServer = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number | null;
      offset?: number;
      canRequest?: CanRequestHistory;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    slot.status = 'loading';
    notify(sessionId);

    return enqueueHistoryMutation(slot, async () => {
      const { canRequest = () => true, ...requestOptions } = opts;
      if (!canRequest()) {
        slot.status = 'idle';
        notify(sessionId);
        return null;
      }

      try {
        const data = await requestSessionHistoryPage(sessionId, requestOptions);
        if ((data.timelineRevision ?? 0) < (slot.timelineRevision ?? 0)) return slot;
        if ((data.timelineRevision ?? 0) > (slot.timelineRevision ?? 0)) slot.realtimeMessages = slot.realtimeMessages.filter(row => (row.seq ?? 0) >= data.timelineRevision! || Boolean(row.replacesAnchorId));
        slot.timelineRevision = data.timelineRevision;
        slot.serverMessages = data.messages;
        slot.oldestCursor = data.oldestCursor;
        slot.total = data.total;
        slot.hasMore = data.hasMore;
        slot.offset = (requestOptions.offset ?? 0) + data.messages.length;
        slot.fetchedAt = Date.now();
        slot.status = 'idle';
        slot.realtimeMessages = pruneRealtimeSupersededByServer(
          slot.serverMessages,
          slot.realtimeMessages,
          slot._deliveryPositions,
        );
        recomputeMergedIfNeeded(slot);
        if (data.tokenUsage !== undefined) {
          slot.tokenUsage = data.tokenUsage;
        }

        notify(sessionId);
        return slot;
      } catch (error) {
        console.error(`[SessionStore] fetch failed for ${sessionId}:`, error);
        slot.status = 'error';
        notify(sessionId);
        return slot;
      }
    });
  }, [getSlot, notify]);

  /**
   * Load older (paginated) messages and prepend to serverMessages.
   */
  const fetchMore = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number;
      canRequest?: CanRequestHistory;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    return enqueueHistoryMutation(slot, async () => {
      let prependedCount = 0;
      let changed = false;
      const canRequest = opts.canRequest ?? (() => true);
      if (!slot.hasMore || !canRequest()) return { slot, prependedCount };

      try {
        // A tail-relative offset can shift while JSONL is still growing. One
        // bounded latest-page reconciliation realigns the cache, after which
        // the older-page request is retried once with the new raw-row offset.
        for (let attempt = 0; attempt < 2 && slot.hasMore; attempt++) {
          if (!canRequest()) break;

          const cachedMessages = slot.serverMessages;
          const expectedTotal = slot.total;
          const cursor = slot.oldestCursor;
          const data = await requestSessionHistoryPage(sessionId, {
            limit: opts.limit ?? SESSION_MESSAGES_PAGE_SIZE,
            ...(cursor ? { before: cursor } : { offset: slot.offset }),
          });
          const olderMerge = mergeOlderServerPage(cachedMessages, data.messages);
          const shiftedWhileFetching = (data.timelineRevision ?? 0) !== (slot.timelineRevision ?? 0) || !cursor && (
            data.total !== expectedTotal
            || olderMerge.overlapLength > 0
            || !olderPagePrecedesCachedHistory(data.messages, cachedMessages)
          );

          if (shiftedWhileFetching) {
            if (attempt > 0 || !canRequest()) break;
            const latestResult = await refreshLatestSlotFromServer(
              sessionId,
              slot,
              SESSION_MESSAGES_PAGE_SIZE,
              canRequest,
            );
            changed = changed || latestResult.changed;
            if (!latestResult.applied) break;
            continue;
          }

          slot.serverMessages = olderMerge.messages;
          slot.oldestCursor = data.oldestCursor;
          slot.hasMore = data.hasMore;
          slot.total = data.total;
          slot.offset = slot.serverMessages.length;
          prependedCount = olderMerge.prependedCount;
          if (data.tokenUsage !== undefined) {
            slot.tokenUsage = data.tokenUsage;
          }
          recomputeMergedIfNeeded(slot);
          changed = true;
          break;
        }

        if (changed) notify(sessionId);
        return { slot, prependedCount };
      } catch (error) {
        console.error(`[SessionStore] fetchMore failed for ${sessionId}:`, error);
        if (changed) notify(sessionId);
        return { slot, prependedCount };
      }
    });
  }, [getSlot, notify]);

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   */
  /**
   * Drops the message carrying `anchorId` and everything after it.
   *
   * Sent when an already-sent message is edited: the replacement streams in
   * from the provider, so the rows it supersedes have to go first or the
   * transcript shows the question twice. Runs on every subscribed client, not
   * just the one that made the edit.
   */
  const truncateAt = useCallback((sessionId: string, anchorId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;

    const cutIndex = slot.serverMessages.findIndex(
      (message) => message.transcriptAnchorId === anchorId,
    );
    if (cutIndex < 0) return;

    slot.serverMessages = slot.serverMessages.slice(0, cutIndex);
    // Anything already streamed belonged to the turn being replaced — except
    // the replacement itself. The client that made the edit appends its
    // optimistic echo before the server acknowledges, so clearing live rows
    // outright took the message the user had just sent with it, and it only
    // came back when the run finished and the transcript was re-read.
    // Only the last one: a send that was refused leaves its echo behind, so a
    // second attempt at the same message would otherwise survive the cut
    // alongside the abandoned first and show the user both.
    const replacements = slot.realtimeMessages.filter(
      (message) => message.replacesAnchorId === anchorId,
    );
    slot.realtimeMessages = replacements.length > 0
      // Stamped here because this is the only place that knows how much of the
      // conversation survived, which is what tells the echo apart from the
      // turns it now sits after.
      ? [{ ...replacements[replacements.length - 1], replacesAfterRowCount: cutIndex }]
      : EMPTY;
    // `total` counts what the server would serve; it is about to be re-fetched
    // anyway, but leaving it high makes the pager offer pages that do not exist.
    slot.total = slot.serverMessages.length;
    slot.offset = slot.serverMessages.length;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [notify]);

  const appendRealtime = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    msg = cleanProviderUserMessage(msg);
    if (isLegacyControlSignal(msg)) return;
    slot.lastRealtimeAt = Date.now();
    if (msg.provider === 'claude') {
      // Reconcile before upserting the completion, including when history has
      // not caught up yet. Finalization must not resurrect the old stream key.
      const completed = [...slot.serverMessages, ...slot.realtimeMessages.filter(row => row.kind === 'text' && row.role === 'assistant')];
      msg = reconcileClaudeBlockAliases(completed, [msg], slot._deliveryPositions)[0];
      if (msg.kind === 'text' && msg.role === 'assistant')
        slot.realtimeMessages = reconcileClaudeBlockAliases([...slot.serverMessages, msg], slot.realtimeMessages, slot._deliveryPositions);
    }
    const position = msg.firstSeq ?? msg.seq;
    const identity = timelineIdentity(msg);
    if (position !== undefined) slot._deliveryPositions.set(identity, Math.min(slot._deliveryPositions.get(identity) ?? position, position));
    const normalizedMessage = { ...msg, sessionId, firstSeq: msg.firstSeq ?? msg.seq };
    // Providers emit full snapshots for the same item as its output grows.
    // Replace that row in place; appending it inflates tool groups and can evict
    // actual conversation history from the bounded realtime cache.
    const existingIndex = slot.realtimeMessages.findIndex(message =>
      (normalizedMessage.messageKey ? message.messageKey === normalizedMessage.messageKey
        : message.id === normalizedMessage.id && message.kind === normalizedMessage.kind)
      && message.provider === normalizedMessage.provider);
    let updated: NormalizedMessage[];
    if (existingIndex >= 0) {
      updated = [...slot.realtimeMessages];
      updated[existingIndex] = { ...normalizedMessage, timestamp: updated[existingIndex].timestamp, firstSeq: updated[existingIndex].firstSeq ?? normalizedMessage.firstSeq };
    } else {
      updated = [...slot.realtimeMessages, normalizedMessage];
    }
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = pruneRealtimeSupersededByServer(slot.serverMessages, updated, slot._deliveryPositions);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Refreshes only the persisted tail and stitches it onto the contiguous
   * cached suffix. Large turns request a small offset bridge rather than the
   * whole transcript, and the final state is applied atomically.
   */
  const refreshLatestFromServer = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number;
      canRequest?: CanRequestHistory;
    } = {},
  ) => {
    const slot = getSlot(sessionId);

    return enqueueHistoryMutation(slot, async () => {
      try {
        const result = await refreshLatestSlotFromServer(
          sessionId,
          slot,
          opts.limit ?? SESSION_MESSAGES_PAGE_SIZE,
          opts.canRequest,
        );
        if (result.changed) notify(sessionId);
        return { slot, ...result };
      } catch (error) {
        console.error(`[SessionStore] latest refresh failed for ${sessionId}:`, error);
        return { slot, applied: false, changed: false, deferred: false };
      }
    });
  }, [getSlot, notify]);

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }, []);

  /**
   * Update or create a streaming message (accumulated text so far).
   * Uses a well-known ID so subsequent calls replace the same message.
   */
  const updateStreaming = useCallback((sessionId: string, accumulatedText: string, msgProvider: LLMProvider) => {
    const slot = getSlot(sessionId);
    const streamId = `__streaming_${sessionId}`;
    const msg: NormalizedMessage = {
      id: streamId,
      sessionId,
      timestamp: new Date().toISOString(),
      provider: msgProvider,
      kind: 'stream_delta',
      content: accumulatedText,
    };
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = { ...msg, timestamp: slot.realtimeMessages[idx].timestamp };
    } else {
      slot.realtimeMessages = [...slot.realtimeMessages, msg];
    }
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Finalize streaming: convert the streaming message to a regular text message.
   * Identity and first-delivery position are preserved, including interrupted replies.
   */
  const finalizeStreaming = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    let changed = false;
    slot.realtimeMessages = slot.realtimeMessages.map(stream => {
      if (stream.kind !== 'stream_delta') return stream;
      changed = true;
      return { ...stream, kind: 'text', role: 'assistant' };
    });
    if (changed) { recomputeMergedIfNeeded(slot); notify(sessionId); }
  }, [notify]);

  /**
   * Get merged messages for a session (for rendering).
   */
  const getMessages = useCallback((sessionId: string): NormalizedMessage[] => {
    return storeRef.current.get(sessionId)?.merged ?? EMPTY;
  }, []);

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = useCallback((sessionId: string): SessionSlot | undefined => {
    return storeRef.current.get(sessionId);
  }, []);

  return useMemo(() => ({
    fetchFromServer,
    fetchMore,
    appendRealtime,
    truncateAt,
    refreshLatestFromServer,
    setActiveSession,
    isStale,
    updateStreaming,
    finalizeStreaming,
    getMessages,
    getSessionSlot,
  }), [
    fetchFromServer, fetchMore, appendRealtime, truncateAt, refreshLatestFromServer,
    setActiveSession, isStale, updateStreaming, finalizeStreaming,
    getMessages, getSessionSlot,
  ]);
}

/** Full store API returned by useSessionStore; chat hooks take it as a parameter. */
export type SessionStore = ReturnType<typeof useSessionStore>;
