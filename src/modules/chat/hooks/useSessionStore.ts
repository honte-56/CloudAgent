/**
 * Session-keyed message store.
 *
 * One slot per session id. The persisted transcript served by the sessions
 * API is the source of truth for what the conversation looks like; live
 * websocket rows exist only to show work the transcript has not caught up
 * with yet. The two are kept apart and combined by one rule:
 *
 *   merged = persisted rows, in server order
 *          + live rows that are not persisted yet, each placed right after the
 *            persisted row that was newest when it arrived
 *
 * Stable identities and persisted neighbours determine placement. Providers
 * without shared identities use echo matching; orphaned replay rows
 * use their timestamp only until a persisted neighbour is available.
 * Session switch = change the active pointer; nothing is cleared.
 * No localStorage for messages.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { stripRuntimeInstructions } from '@/shared/utils';
import type { NormalizedMessage, SessionMessagesRequestOptions } from '@/shared/types';
import { SESSION_MESSAGES_PAGE_SIZE } from '@/shared/constants';
import { matchPersistedUserEchoes } from '@/modules/chat/utils/sessionMessageReconciliation';
import {
  mergeLatestServerPage,
  mergeOlderServerPage,
} from '@/modules/chat/utils/sessionMessagePagination';

// ─── Per-session slot ────────────────────────────────────────────────────────

type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

/**
 * Where a live row sits among persisted rows, by persisted identity. `after`
 * is the persisted row that was newest when the live row arrived; `before` is
 * used instead when a row arrived with no persisted history loaded yet and a
 * later live row has since been persisted.
 */
type LiveAnchor = { after?: string; before?: string };

type SessionSlot = {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  merged: NormalizedMessage[];
  /** @internal Cache-invalidation refs for recomputeMergedIfNeeded */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  /**
   * @internal Serializes history reads for this session so an older-page
   * request calculates its cursor after any latest-page refresh completes.
   */
  _historyMutationQueue: Promise<void>;
  /** @internal Placement of each live row, keyed by the row's identity. */
  _liveAnchors: Map<string, LiveAnchor>;
  status: SessionStatus;
  fetchedAt: number;
  /** Last live update, allowing the visible pane to avoid redundant file polling while streaming. */
  lastRealtimeAt?: number;
  total: number;
  hasMore: boolean;
  offset: number;
  /** Stable oldest loaded identity used by the history cursor API. */
  oldestCursor?: string;
  /** Journal revision of the last page; a higher one means the transcript was cut and live rows before it are stale. */
  timelineRevision?: number;
  tokenUsage: unknown;
};

const EMPTY: NormalizedMessage[] = [];
const SESSION_HISTORY_REQUEST_TIMEOUT_MS = 30_000;
/** Upper bound on live rows per session; beyond it the oldest unpersisted rows go. */
const MAX_REALTIME_MESSAGES = 500;
/** How many older pages a latest-page refresh walks back to reconnect with the cached tail before giving up and replacing it. */
const MAX_REFRESH_BRIDGE_PAGES = 3;
const STALE_THRESHOLD_MS = 30_000;

function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    _historyMutationQueue: Promise.resolve(),
    _liveAnchors: new Map(),
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    // `undefined` means "no page has reported usage for this session yet", and
    // every consumer distinguishes that from a reported `null`.
    tokenUsage: undefined,
  };
}

// ─── Identity ────────────────────────────────────────────────────────────────

/**
 * The one key a row is known by on both sides of the wire: the provider's
 * stable item identity when it has one, the tool call id for tool rows (a
 * live result row and the persisted call it belongs to share it), else the id.
 */
function timelineIdentity(row: NormalizedMessage): string {
  return row.messageKey || (row.toolId ? `${row.kind}:${row.toolId}` : row.id);
}

/** Older Codex builds journaled lifecycle signals as tool rows; they are not transcript content. */
function isLegacyControlSignal(row: NormalizedMessage): boolean {
  return row.provider === 'codex' && row.kind === 'tool_use' && (['subAgentActivity', 'SubAgentActivity'].includes(row.toolName || '')
    || row.toolName === 'TodoWrite' && (row.toolId || row.id).endsWith('-plan'));
}

// Only provider-owned rows carry injected context. Local composer text must
// remain byte-for-byte intact, including a user quoting the instruction text.
function cleanProviderUserMessage(row: NormalizedMessage): NormalizedMessage {
  if (row.kind !== 'text' || row.role !== 'user' || row.id.startsWith('local_') || row.runtimeContextStripped || typeof row.content !== 'string') return row;
  return { ...row, content: stripRuntimeInstructions(row.content), runtimeContextStripped: true };
}

// ─── History transport ───────────────────────────────────────────────────────

type SessionHistoryPage = {
  oldestCursor?: string;
  timelineRevision?: number;
  messages: NormalizedMessage[];
  total: number;
  hasMore: boolean;
  tokenUsage?: unknown;
};

function enqueueHistoryMutation<T>(slot: SessionSlot, operation: () => Promise<T>): Promise<T> {
  const result = slot._historyMutationQueue.then(operation);
  slot._historyMutationQueue = result.then(() => undefined, () => undefined);
  return result;
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
    ...(data && typeof data === 'object' && 'tokenUsage' in data ? { tokenUsage: data.tokenUsage } : {}),
  };
}

// ─── Reconciling live rows with a persisted page ─────────────────────────────

/**
 * Retires the live copy of a reply that streamed without a provider identity.
 *
 * Cursor and OpenCode stream text under a key this client made up, so the
 * persisted reply can only be recognised by its words. Matching is one-to-one
 * against persisted assistant text so two identical replies stay two rows.
 */
function matchKeylessAssistantEchoes(server: NormalizedMessage[], live: NormalizedMessage[]): Map<NormalizedMessage, NormalizedMessage> {
  const claimed = new Set<number>();
  const matches = new Map<NormalizedMessage, NormalizedMessage>();
  for (const row of live) {
    const keyless = !row.messageKey || row.messageKey.startsWith('legacy:');
    if (!keyless || row.role !== 'assistant' || row.kind !== 'text' || !row.content?.trim()) continue;
    const text = row.content.trim();
    const index = server.findIndex((candidate, position) => !claimed.has(position)
      && candidate.kind === 'text' && candidate.role === 'assistant' && (candidate.content || '').trim() === text);
    if (index < 0) continue;
    claimed.add(index);
    matches.set(row, server[index]);
  }
  return matches;
}

/** True when a live text row is further along than the persisted copy of the same item. */
function liveTextIsAhead(live: NormalizedMessage, persisted: NormalizedMessage): boolean {
  const isText = live.kind === 'stream_delta' || (live.kind === 'text' && live.role === 'assistant');
  return isText && (live.content?.length ?? 0) > (persisted.content?.length ?? 0);
}

/**
 * Drops every live row the persisted page now owns and re-anchors the rest.
 *
 * Live rows are kept in delivery order, so the persisted rows among them say
 * where the unpersisted ones belong: right after the nearest persisted row
 * delivered before them, or — for rows that arrived before anything persisted
 * had been delivered — right before the nearest persisted row delivered after
 * them. Only a row with no persisted neighbour at all keeps the anchor it was
 * given on arrival. This is what keeps a replayed turn that is longer than the
 * loaded page above that page instead of under it.
 */
function reconcileLiveWithServer(slot: SessionSlot): void {
  const server = slot.serverMessages;
  const anchors = slot._liveAnchors;
  const persistedByIdentity = new Map(server.map((row) => [timelineIdentity(row), row]));
  // A tool result is drawn inside its call: once the persisted call carries
  // the result, the live result row has nothing left to say.
  const callIdentityByResultToolId = new Map<string, string>();
  for (const row of server) {
    if (row.kind === 'tool_use' && row.toolId && row.toolResult) {
      callIdentityByResultToolId.set(row.toolId, timelineIdentity(row));
    }
  }

  const candidates = slot.realtimeMessages;
  const echoMatches = new Map([
    ...matchPersistedUserEchoes(server, candidates),
    ...matchKeylessAssistantEchoes(server, candidates),
  ]);
  const persistedAs = candidates.map((row): string | undefined => {
    const identity = timelineIdentity(row);
    const persisted = persistedByIdentity.get(identity);
    if (persisted) {
      // A stream ahead of the transcript is still live; the merge shows it.
      return liveTextIsAhead(row, persisted) ? undefined : identity;
    }
    const echo = echoMatches.get(row);
    if (echo) return timelineIdentity(echo);
    return row.kind === 'tool_result' && row.toolId ? callIdentityByResultToolId.get(row.toolId) : undefined;
  });

  const serverIndex = new Map(server.map((row, index) => [timelineIdentity(row), index]));
  const kept: NormalizedMessage[] = [];
  let previousPersisted: string | undefined;
  for (let index = 0; index < candidates.length; index += 1) {
    const row = candidates[index];
    const identity = timelineIdentity(row);
    if (persistedAs[index]) {
      anchors.delete(identity);
      previousPersisted = persistedAs[index];
      continue;
    }

    kept.push(row);
    const existing = anchors.get(identity);
    const existingAfter = existing?.after !== undefined && serverIndex.has(existing.after) ? existing.after : undefined;
    const existingBefore = existing?.before !== undefined && serverIndex.has(existing.before) ? existing.before : undefined;

    // Every persisted row delivered before this one is a lower bound on where
    // it belongs; the newest of them is the tightest, so it wins over an
    // older lower bound remembered from arrival.
    const after = [previousPersisted, existingAfter].filter((bound): bound is string => bound !== undefined)
      .sort((a, b) => serverIndex.get(b)! - serverIndex.get(a)!)[0];

    // An established position before a persisted neighbour is already more
    // precise than a newly delivered lower bound farther back in history.
    // Preserve it unless the lower bound actually passes that neighbour.
    if (existingBefore && (!after || serverIndex.get(after)! < serverIndex.get(existingBefore)!)) {
      const nextPersisted = persistedAs.slice(index + 1).find(Boolean);
      const before = nextPersisted && serverIndex.get(nextPersisted)! < serverIndex.get(existingBefore)!
        && (!after || serverIndex.get(nextPersisted)! > serverIndex.get(after)!) ? nextPersisted : existingBefore;
      anchors.set(identity, { before });
      continue;
    }
    if (after) {
      anchors.set(identity, { after });
      continue;
    }

    // Short of a lower bound, the earliest persisted row delivered after it
    // is the tightest upper bound.
    const nextPersisted = persistedAs.slice(index + 1).find(Boolean);
    const before = [nextPersisted, existingBefore].filter((bound): bound is string => bound !== undefined)
      .sort((a, b) => serverIndex.get(a)! - serverIndex.get(b)!)[0];
    if (before) {
      anchors.set(identity, { before });
      continue;
    }

    // No persisted neighbour and no usable anchor: a replayed row whose turn
    // the loaded page does not reach, or a row whose anchor left the cache.
    // Its own clock is the only placement left; it is used once, here, and
    // then the anchor holds. Not for the echo of an edit's replacement: it is
    // the newest thing in the conversation by definition, and a provider that
    // rewinds by copying the kept turns re-stamps them later than it was typed.
    if (row.replacesAnchorId) {
      anchors.delete(identity);
      continue;
    }
    const time = Date.parse(row.timestamp);
    const laterIndex = Number.isFinite(time) ? server.findIndex((candidate) => (Date.parse(candidate.timestamp) || 0) > time) : -1;
    if (laterIndex >= 0) anchors.set(identity, { before: timelineIdentity(server[laterIndex]) });
    else anchors.delete(identity);
  }

  const keptIdentities = new Set(kept.map(timelineIdentity));
  for (const identity of [...anchors.keys()]) {
    if (!keptIdentities.has(identity)) anchors.delete(identity);
  }

  const unchanged = kept.length === slot.realtimeMessages.length && kept.every((row, index) => row === slot.realtimeMessages[index]);
  if (!unchanged) slot.realtimeMessages = kept;
}

// ─── Merge ───────────────────────────────────────────────────────────────────

function computeMerged(server: NormalizedMessage[], live: NormalizedMessage[], anchors: Map<string, LiveAnchor>): NormalizedMessage[] {
  const rows = [...server];
  const indexByIdentity = new Map(server.map((row, index) => [timelineIdentity(row), index]));
  const before = new Map<number, NormalizedMessage[]>();
  const after = new Map<number, NormalizedMessage[]>();
  const tail: NormalizedMessage[] = [];
  const bucket = (map: Map<number, NormalizedMessage[]>, index: number, row: NormalizedMessage) => {
    const list = map.get(index);
    if (list) list.push(row); else map.set(index, [row]);
  };

  for (const row of live) {
    const identity = timelineIdentity(row);
    const index = indexByIdentity.get(identity);
    if (index !== undefined) {
      // The persisted copy is authoritative, except that a stream still ahead
      // of what the transcript holds is the fresher text.
      const persisted = rows[index];
      if (liveTextIsAhead(row, persisted)) {
        rows[index] = { ...row, timestamp: persisted.timestamp };
      }
      continue;
    }

    const anchor = anchors.get(identity);
    const afterIndex = anchor?.after !== undefined ? indexByIdentity.get(anchor.after) : undefined;
    if (afterIndex !== undefined) { bucket(after, afterIndex, row); continue; }
    const beforeIndex = anchor?.before !== undefined ? indexByIdentity.get(anchor.before) : undefined;
    if (beforeIndex !== undefined) { bucket(before, beforeIndex, row); continue; }
    tail.push(row);
  }

  const merged: NormalizedMessage[] = [];
  rows.forEach((row, index) => {
    const leading = before.get(index);
    if (leading) merged.push(...leading);
    merged.push(row);
    const trailing = after.get(index);
    if (trailing) merged.push(...trailing);
  });
  merged.push(...tail);
  return merged;
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) {
    return false;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages, slot._liveAnchors);
  return true;
}

/**
 * Applies a journal revision carried by a history page. A revision is stamped
 * when the transcript is cut for an edit; live rows delivered before it belong
 * to the branch that was cut away, except the echo of the replacement itself.
 */
function applyTimelineRevision(slot: SessionSlot, revision: number | undefined): boolean {
  if (revision === undefined || revision <= (slot.timelineRevision ?? 0)) return false;
  slot.realtimeMessages = slot.realtimeMessages.filter((row) => (row.seq ?? 0) >= revision || Boolean(row.replacesAnchorId));
  slot.timelineRevision = revision;
  return true;
}

// Token usage is JSON response data, so compare its serialized value instead
// of treating each freshly parsed response object as a state change.
function hasEquivalentTokenUsage(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

function olderPagePrecedesCachedHistory(olderMessages: NormalizedMessage[], cachedMessages: NormalizedMessage[]): boolean {
  const olderNewest = olderMessages[olderMessages.length - 1];
  const cachedOldest = cachedMessages[0];
  if (!olderNewest || !cachedOldest) return true;
  const olderTime = Date.parse(olderNewest.timestamp);
  const cachedTime = Date.parse(cachedOldest.timestamp);
  return !Number.isFinite(olderTime) || !Number.isFinite(cachedTime) || olderTime <= cachedTime;
}

/** Adopts a page's rows while keeping the object identity of rows that did not change, so memoized rows skip work. */
function retainUnchangedRows(previous: NormalizedMessage[], next: NormalizedMessage[]): NormalizedMessage[] {
  const previousByIdentity = new Map(previous.map((row) => [timelineIdentity(row), row]));
  const retained = next.map((row) => {
    const candidate = previousByIdentity.get(timelineIdentity(row));
    return candidate && (candidate === row || JSON.stringify(candidate) === JSON.stringify(row)) ? candidate : row;
  });
  const same = retained.length === previous.length && retained.every((row, index) => row === previous[index]);
  return same ? previous : retained;
}

type LatestHistoryRefreshResult = {
  applied: boolean;
  changed: boolean;
  deferred: boolean;
};

type CanRequestHistory = () => boolean;

/**
 * Refreshes the persisted tail and stitches it onto the cached pages.
 *
 * The latest page normally overlaps the cached tail and replaces it. When a
 * whole page or more was added since the last refresh, a few older pages are
 * walked back through the cursor API until the overlap is found; failing that
 * the cache is replaced by the fetched window, which is always a correct
 * transcript suffix even if it drops already-loaded older pages.
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

  const latestPage = await requestSessionHistoryPage(sessionId, { limit, offset: 0 });
  if (latestPage.timelineRevision !== undefined && latestPage.timelineRevision < (slot.timelineRevision ?? 0)) {
    return { applied: false, changed: false, deferred: false };
  }
  const revised = applyTimelineRevision(slot, latestPage.timelineRevision);
  const cached = revised ? EMPTY : slot.serverMessages;

  let fetchedWindow = latestPage.messages;
  let oldestFetchedPage = latestPage;
  let nextServerMessages: NormalizedMessage[];
  let nextHasMore: boolean;

  if (!latestPage.hasMore || cached.length === 0) {
    // A page with no older rows is the complete authoritative transcript. This
    // also removes cached rows after a provider-side truncation.
    nextServerMessages = fetchedWindow;
    nextHasMore = latestPage.hasMore;
  } else {
    let stitched = mergeLatestServerPage(cached, fetchedWindow);
    for (let page = 0; stitched.overlapLength === 0 && page < MAX_REFRESH_BRIDGE_PAGES && oldestFetchedPage.hasMore; page += 1) {
      if (!canRequest()) {
        return { applied: false, changed: false, deferred: true };
      }
      const cursor = oldestFetchedPage.oldestCursor;
      if (!cursor) break;
      const olderPage = await requestSessionHistoryPage(sessionId, { limit, before: cursor });
      if (olderPage.messages.length === 0) break;
      fetchedWindow = mergeOlderServerPage(fetchedWindow, olderPage.messages).messages;
      oldestFetchedPage = olderPage;
      stitched = mergeLatestServerPage(cached, fetchedWindow);
    }
    if (stitched.overlapLength > 0) {
      nextServerMessages = stitched.messages;
      nextHasMore = slot.hasMore && oldestFetchedPage.hasMore;
    } else {
      console.warn(`[SessionStore] Latest history of ${sessionId} does not reach the cached rows; replacing them with the fetched window.`);
      nextServerMessages = fetchedWindow;
      nextHasMore = oldestFetchedPage.hasMore;
    }
  }

  let changed = revised;
  if (latestPage.tokenUsage !== undefined && !hasEquivalentTokenUsage(latestPage.tokenUsage, slot.tokenUsage)) {
    slot.tokenUsage = latestPage.tokenUsage;
    changed = true;
  }

  slot.serverMessages = retainUnchangedRows(slot.serverMessages, nextServerMessages);
  slot.oldestCursor = slot.serverMessages[0]?.messageKey || slot.serverMessages[0]?.id;
  slot.total = latestPage.total;
  slot.offset = slot.serverMessages.length;
  slot.hasMore = nextHasMore;
  slot.fetchedAt = Date.now();
  reconcileLiveWithServer(slot);
  changed = recomputeMergedIfNeeded(slot) || changed;

  return { applied: true, changed, deferred: false };
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore() {
  // Retain each session's history and pending live rows across view switches.
  const storeRef = useRef(new Map<string, SessionSlot>());
  // Only the viewed session needs to trigger a React render when it changes.
  const activeSessionIdRef = useRef<string | null>(null);
  // Bump to force re-render — only when the active session's data changes.
  // Session ids are stable for the whole conversation lifetime (the backend
  // allocates them before the first send), so slots are keyed directly.
  const [, setTick] = useState(0);
  const notify = useCallback((sessionId: string) => {
    if (sessionId === activeSessionIdRef.current) {
      setTick((n) => n + 1);
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
    opts: { limit?: number | null; offset?: number; canRequest?: CanRequestHistory } = {},
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
        applyTimelineRevision(slot, data.timelineRevision);
        slot.serverMessages = retainUnchangedRows(slot.serverMessages, data.messages);
        slot.oldestCursor = data.oldestCursor;
        slot.total = data.total;
        slot.hasMore = data.hasMore;
        slot.offset = (requestOptions.offset ?? 0) + data.messages.length;
        slot.fetchedAt = Date.now();
        slot.status = 'idle';
        reconcileLiveWithServer(slot);
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
    opts: { limit?: number; canRequest?: CanRequestHistory } = {},
  ) => {
    const slot = getSlot(sessionId);
    return enqueueHistoryMutation(slot, async () => {
      let prependedCount = 0;
      let changed = false;
      const canRequest = opts.canRequest ?? (() => true);
      if (!slot.hasMore || !canRequest()) return { slot, prependedCount };

      try {
        // A tail-relative offset can shift while the transcript is still
        // growing. One latest-page refresh realigns the cache, after which the
        // older-page request is retried once.
        for (let attempt = 0; attempt < 2 && slot.hasMore; attempt++) {
          if (!canRequest()) break;

          const cachedMessages = slot.serverMessages;
          const cursor = slot.oldestCursor;
          const data = await requestSessionHistoryPage(sessionId, {
            limit: opts.limit ?? SESSION_MESSAGES_PAGE_SIZE,
            ...(cursor ? { before: cursor } : { offset: slot.offset }),
          });
          const olderMerge = mergeOlderServerPage(cachedMessages, data.messages);
          const shiftedWhileFetching = (data.timelineRevision ?? 0) !== (slot.timelineRevision ?? 0) || (!cursor && (
            data.total !== slot.total
            || olderMerge.overlapLength > 0
            || !olderPagePrecedesCachedHistory(data.messages, cachedMessages)
          ));

          if (shiftedWhileFetching) {
            if (attempt > 0 || !canRequest()) break;
            const latestResult = await refreshLatestSlotFromServer(sessionId, slot, SESSION_MESSAGES_PAGE_SIZE, canRequest);
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
          reconcileLiveWithServer(slot);
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

    const cutIndex = slot.serverMessages.findIndex((message) => message.transcriptAnchorId === anchorId);
    if (cutIndex < 0) return;

    slot.serverMessages = slot.serverMessages.slice(0, cutIndex);
    // Anything already streamed belonged to the turn being replaced — except
    // the replacement itself. The client that made the edit appends its
    // optimistic echo before the server acknowledges, so clearing live rows
    // outright took the message the user had just sent with it.
    // Only the last one: a send that was refused leaves its echo behind, so a
    // second attempt at the same message would otherwise survive the cut
    // alongside the abandoned first and show the user both.
    const replacements = slot.realtimeMessages.filter((message) => message.replacesAnchorId === anchorId);
    slot._liveAnchors.clear();
    const lastKept = slot.serverMessages[slot.serverMessages.length - 1];
    if (replacements.length > 0 && lastKept) {
      slot._liveAnchors.set(timelineIdentity(replacements[replacements.length - 1]), { after: timelineIdentity(lastKept) });
    }
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

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   *
   * A row already held live (same identity) is replaced in place: providers
   * emit full snapshots of an item as it grows, and appending each one would
   * inflate tool groups and evict real history from the bounded live list.
   * A new row is anchored after the newest persisted row, and is ordered among
   * live rows by first delivery (`firstSeq`), so a reply replayed after the
   * tools that followed its first fragment still comes before them.
   */
  const appendRealtime = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    msg = cleanProviderUserMessage(msg);
    if (isLegacyControlSignal(msg)) return;
    slot.lastRealtimeAt = Date.now();

    const incoming: NormalizedMessage = { ...msg, sessionId, firstSeq: msg.firstSeq ?? msg.seq };
    const identity = timelineIdentity(incoming);
    const live = slot.realtimeMessages;
    const existingIndex = live.findIndex((row) => timelineIdentity(row) === identity && row.provider === incoming.provider);

    let updated: NormalizedMessage[];
    if (existingIndex >= 0) {
      const existing = live[existingIndex];
      // A late partial snapshot must never replace the completed item.
      if (incoming.kind === 'stream_delta' && existing.kind === 'text' && (existing.content?.length ?? 0) >= (incoming.content?.length ?? 0)) return;
      updated = [...live];
      updated[existingIndex] = { ...incoming, timestamp: existing.timestamp, firstSeq: existing.firstSeq ?? incoming.firstSeq };
    } else {
      const position = incoming.firstSeq;
      const insertAt = position === undefined
        ? live.length
        : (() => {
          const later = live.findIndex((row) => (row.firstSeq ?? row.seq) !== undefined && (row.firstSeq ?? row.seq)! > position);
          return later < 0 ? live.length : later;
        })();
      updated = [...live.slice(0, insertAt), incoming, ...live.slice(insertAt)];
      // Inserted among earlier rows: sit where the row it precedes sits.
      // Appended live: right after whatever the transcript holds newest. A
      // replayed row is older than the page loaded beside it, so it waits for
      // `settleReplay` to place it from its persisted neighbours instead.
      const neighbour = insertAt < live.length ? slot._liveAnchors.get(timelineIdentity(live[insertAt])) : undefined;
      const newest = slot.serverMessages[slot.serverMessages.length - 1];
      const anchor: LiveAnchor | undefined = neighbour ?? (newest && !incoming.isReplay ? { after: timelineIdentity(newest) } : undefined);
      if (anchor) slot._liveAnchors.set(identity, anchor); else slot._liveAnchors.delete(identity);
    }

    slot.realtimeMessages = updated;
    if (updated.length > MAX_REALTIME_MESSAGES) {
      reconcileLiveWithServer(slot);
      if (slot.realtimeMessages.length > MAX_REALTIME_MESSAGES) {
        const dropped = slot.realtimeMessages.slice(0, slot.realtimeMessages.length - MAX_REALTIME_MESSAGES);
        for (const row of dropped) slot._liveAnchors.delete(timelineIdentity(row));
        slot.realtimeMessages = slot.realtimeMessages.slice(-MAX_REALTIME_MESSAGES);
      }
    }
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Places the rows a replay just delivered against the history already loaded.
   * Called once per replay batch; a batch that lands before any history is
   * placed by the first page fetch instead.
   */
  const settleReplay = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot || slot.serverMessages.length === 0 || slot.realtimeMessages.length === 0) return;
    reconcileLiveWithServer(slot);
    // Anchors changed even where the row list did not; the merge must rerun.
    slot._lastRealtimeRef = EMPTY;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [notify]);

  /**
   * Refreshes only the persisted tail and stitches it onto the contiguous
   * cached suffix; see `refreshLatestSlotFromServer`.
   */
  const refreshLatestFromServer = useCallback(async (
    sessionId: string,
    opts: { limit?: number; canRequest?: CanRequestHistory } = {},
  ) => {
    const slot = getSlot(sessionId);

    return enqueueHistoryMutation(slot, async () => {
      try {
        const result = await refreshLatestSlotFromServer(sessionId, slot, opts.limit ?? SESSION_MESSAGES_PAGE_SIZE, opts.canRequest);
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
   * Finalize streaming: convert every streaming row into a regular text row.
   * Identity and first-delivery position are preserved, including interrupted replies.
   */
  const finalizeStreaming = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    let changed = false;
    slot.realtimeMessages = slot.realtimeMessages.map((stream) => {
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
    settleReplay,
    refreshLatestFromServer,
    setActiveSession,
    isStale,
    finalizeStreaming,
    getMessages,
    getSessionSlot,
  }), [
    fetchFromServer, fetchMore, appendRealtime, truncateAt, settleReplay, refreshLatestFromServer,
    setActiveSession, isStale, finalizeStreaming, getMessages, getSessionSlot,
  ]);
}

/** Full store API returned by useSessionStore; chat hooks take it as a parameter. */
export type SessionStore = ReturnType<typeof useSessionStore>;
