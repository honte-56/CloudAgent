import { readFileSync } from 'node:fs';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useRef } from 'react';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { api } from '@/shared/api';
import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: { providers: { sessionMessages: vi.fn() } } }));

// Optional local capture: normalized history.json plus journal events.json.
// Captures stay outside the repository because they contain private conversations.
const captureDirectory = process.env.CLOUDCLI_SESSION_REPLAY_DIR;
const fullHistory: NormalizedMessage[] = captureDirectory ? JSON.parse(readFileSync(`${captureDirectory}/history.json`, 'utf8')).messages : [];
const events: NormalizedMessage[] = captureDirectory ? JSON.parse(readFileSync(`${captureDirectory}/events.json`, 'utf8')).map((r: { payload: string }) => JSON.parse(r.payload)) : [];
const sessionId = events[0]?.sessionId ?? 'recorded-session';
const replayTest = test.skipIf(!captureDirectory);

let now = '';
const endOfCapture = [...fullHistory, ...events].reduce((latest, row) => row.timestamp > latest ? row.timestamp : latest, '');
function sliceTail<T>(items: T[], limit: number | null, offset: number) {
  const total = items.length; const end = Math.max(0, total - offset);
  if (limit === null) return { page: items.slice(0, end), hasMore: false };
  const start = Math.max(0, end - limit); return { page: items.slice(start, end), hasMore: start > 0 };
}
function serveHistory(_sid: string, opts: { limit?: number | null; offset?: number; before?: string }) {
  const all = fullHistory.filter((m) => m.timestamp <= now);
  let offset = opts.offset ?? 0;
  if (opts.before) { const i = all.findIndex((m) => (m.messageKey || m.id) === opts.before); if (i < 0) return { ok: false, status: 409, json: async () => ({}) }; offset = all.length - i; }
  const { page, hasMore } = sliceTail(all, opts.limit ?? null, offset);
  return { ok: true, status: 200, json: async () => ({ data: { messages: page, total: all.length, hasMore, offset, limit: opts.limit ?? null, oldestCursor: page[0]?.messageKey || page[0]?.id, timelineRevision: 0 } }) };
}

function harness() {
  let listener: (msg: ServerEvent) => void = () => {};
  const subscribe = (fn: typeof listener) => { listener = fn; return () => {}; };
  const refreshes: Array<Promise<unknown>> = [];
  const view = renderHook(() => {
    const store = useSessionStore(); store.setActiveSession(sessionId);
    // Retain the received delivery cursor across hook renders, as a real tab does.
    const seq = useRef(new Map<string, number>());
    useChatRealtimeHandlers({ isActive: true, subscribe, provider: 'claude', selectedSession: { id: sessionId } as ProjectSession, currentSessionId: sessionId,
      setTokenBudget: () => {}, pendingPermissionRequests: [], setPendingPermissionRequests: () => {}, lastSeqRef: seq, statusCheckSentAtRef: useRef(new Map()),
      requestLatestMessages: async (sid) => { refreshes.push(store.refreshLatestFromServer(sid, { limit: 20 })); }, sessionStore: store });
    return store;
  });
  return { view, send: (m: ServerEvent) => listener(m), refreshes };
}

function assertTimeline(store: ReturnType<typeof useSessionStore>) {
  const slot = store.getSessionSlot(sessionId)!;
  const visible = normalizedToChatMessages(store.getMessages(sessionId));
  const persisted = normalizedToChatMessages(slot.serverMessages);
  const persistedIds = new Set(persisted.map(row => row.id));
  // Every loaded persisted row occurs once and keeps authoritative file order.
  expect(visible.filter(row => persistedIds.has(row.id)).map(row => row.id)).toEqual(persisted.map(row => row.id));
  expect(new Set(visible.map(row => row.id)).size).toBe(visible.length);
  expect(visible.some(row => row.isStreaming)).toBe(false);
  return visible;
}

beforeEach(() => { vi.useFakeTimers(); vi.mocked(api.providers.sessionMessages).mockImplementation(serveHistory as never); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

replayTest('scenario A: live session from the start', { timeout: 30000 }, async () => {
  const { view, send, refreshes } = harness();
  now = events[0].timestamp;
  await act(async () => { await view.result.current.fetchFromServer(sessionId, { limit: 20, offset: 0 }); });
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    now = ev.timestamp > now ? ev.timestamp : now;
    await act(async () => { send(ev as ServerEvent); if (ev.kind === 'stream_delta') vi.advanceTimersByTime(60); });
    const next = events[i + 1];
    const gap = next ? Date.parse(next.timestamp) - Date.parse(ev.timestamp) : 0;
    if (gap > 2000) { // the 2s poll fires while idle
      now = new Date(Date.parse(ev.timestamp) + 2000).toISOString();
      await act(async () => { refreshes.push(view.result.current.refreshLatestFromServer(sessionId, { limit: 20 })); });
    }
    await act(async () => { await Promise.all(refreshes.splice(0)); });
  }
  now = endOfCapture;
  await act(async () => { await view.result.current.refreshLatestFromServer(sessionId, { limit: 20 }); });
  const visible = assertTimeline(view.result.current);
  expect(view.result.current.getSessionSlot(sessionId)?.serverMessages.map(row => row.id)).toEqual(fullHistory.map(row => row.id));
  // Some queued inputs never reached the provider transcript. Keep those live
  // user messages instead of deleting them just to force equality with history.
  const persistedIds = new Set(normalizedToChatMessages(fullHistory).map(row => row.id));
  expect(visible.filter(row => !persistedIds.has(row.id)).every(row => row.type === 'user')).toBe(true);
});

function replayFrom(send: (m: ServerEvent) => void, afterSeq: number, cursor: number, isProcessing: boolean) {
  send({ kind: 'chat_subscribed', sessionId: sessionId, isProcessing, lastSeq: cursor, resetCursor: false, historyRequired: true, pendingPermissions: [] } as unknown as ServerEvent);
  for (const ev of events) if (ev.seq! > afterSeq && ev.seq! <= cursor && !['complete', 'status', 'permission_request', 'permission_resolved', 'permission_cancelled', 'session_created'].includes(ev.kind)) send({ ...ev, isReplay: true } as ServerEvent);
  send({ kind: 'chat_replay_complete', sessionId: sessionId, cursor, isProcessing } as unknown as ServerEvent);
}

replayTest('scenario B: reload after the session ended (history page + replay of the last turn)', async () => {
  const { view, send } = harness();
  now = endOfCapture;
  await act(async () => { await view.result.current.fetchFromServer(sessionId, { limit: 20, offset: 0 }); });
  const completions = events.filter(event => event.kind === 'complete');
  const lastTurnStart = completions.at(-2)?.seq ?? 0;
  await act(async () => { replayFrom(send, lastTurnStart, events.at(-1)!.seq!, false); vi.advanceTimersByTime(60); });
  await act(async () => { await view.result.current.refreshLatestFromServer(sessionId, { limit: 20 }); });
  assertTimeline(view.result.current);
  // The last turn can exceed a single page. Once that history is loaded, all
  // replay copies must converge to the exact persisted transcript.
  await act(async () => { await view.result.current.fetchFromServer(sessionId, { limit: null }); });
  expect(assertTimeline(view.result.current).map(row => row.id)).toEqual(normalizedToChatMessages(fullHistory).map(row => row.id));
});

replayTest('scenario C: reload in the middle of a turn, then follow it live to the end', { timeout: 30000 }, async () => {
  const { view, send, refreshes } = harness();
  const reloadAt = events[Math.floor(events.length * 0.75)].seq!;
  const turnStart = events.filter(event => event.kind === 'complete' && event.seq! < reloadAt).at(-1)?.seq ?? 0;
  now = events.find((e) => e.seq === reloadAt)!.timestamp;
  await act(async () => { await view.result.current.fetchFromServer(sessionId, { limit: 20, offset: 0 }); });
  await act(async () => { replayFrom(send, turnStart, reloadAt, true); vi.advanceTimersByTime(60); });
  for (let i = events.findIndex((e) => e.seq! > reloadAt); i < events.length; i += 1) {
    const ev = events[i];
    now = ev.timestamp > now ? ev.timestamp : now;
    await act(async () => { send(ev as ServerEvent); if (ev.kind === 'stream_delta') vi.advanceTimersByTime(60); });
    const next = events[i + 1];
    const gap = next ? Date.parse(next.timestamp) - Date.parse(ev.timestamp) : 0;
    if (gap > 2000) { now = new Date(Date.parse(ev.timestamp) + 2000).toISOString(); await act(async () => { refreshes.push(view.result.current.refreshLatestFromServer(sessionId, { limit: 20 })); }); }
    await act(async () => { await Promise.all(refreshes.splice(0)); });
  }
  now = endOfCapture;
  await act(async () => { await view.result.current.refreshLatestFromServer(sessionId, { limit: 20 }); });
  assertTimeline(view.result.current);
  await act(async () => { await view.result.current.fetchFromServer(sessionId, { limit: null }); });
  expect(assertTimeline(view.result.current).map(row => row.id)).toEqual(normalizedToChatMessages(fullHistory).map(row => row.id));
});
