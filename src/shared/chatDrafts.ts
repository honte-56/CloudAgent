import { api } from '@/shared/api';
import type { QueuedSendOptions } from '@/shared/types';

/**
 * Unsent composer text and queued messages, stored in `auth.db` rather than in
 * the browser.
 *
 * This is what lets a message half-typed on a laptop be finished on a phone —
 * the case the composer previously could not serve at all, because a draft only
 * existed on the machine it was typed on. As with the preference store, a
 * localStorage mirror is kept purely so a reload shows the draft on the first
 * paint instead of a blank composer that fills in a moment later.
 *
 * A scope is a session id, or `project:<projectId>` for a chat that has not
 * been sent yet and so has no session. Drafts used to be keyed by project
 * alone, which meant every session in a project shared one draft.
 */

/** A queued message as it is stored: text plus the send options it was composed under. */
export type StoredQueuedMessage = {
  content: string;
  /** Delivery paused after failure; editing explicitly enables a retry. */
  deliveryError?: string;
  options?: QueuedSendOptions;
  /** Legacy image-only descriptors retained for queued draft compatibility. */
  images?: unknown[];
  /**
   * JSON-safe descriptors returned by POST /api/assets/files. Unlike browser
   * File objects, they can follow a queued message across session switches.
   */
  attachments?: unknown[];
};

type DraftRecord = {
  text: string;
  queuedMessage: StoredQueuedMessage | null;
};

/** Fired after any draft changes, from a local write or from a hydrate. */
export const CHAT_DRAFTS_CHANGED_EVENT = 'chat-drafts:changed';

const MIRROR_STORAGE_KEY = 'chat-drafts';

/**
 * Longer than the preference debounce: this fires on every keystroke, and a
 * draft is only ever read back on a reload or a device switch, so trading a
 * little latency for far fewer requests is the right side of the trade.
 */
const SERVER_WRITE_DEBOUNCE_MS = 1_000;

const EMPTY_DRAFT: DraftRecord = { text: '', queuedMessage: null };

const listeners = new Set<() => void>();

let drafts = new Map<string, DraftRecord>();
const pendingScopes = new Set<string>();
// Serialize saves and hold edits while a queued message is claimed for live input.
const serverWrites = new Map<string, Promise<void>>();
const deliveringScopes = new Set<string>();
let serverWriteTimer: ReturnType<typeof setTimeout> | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isEmptyDraft = (draft: DraftRecord): boolean => (
  draft.text === '' && draft.queuedMessage === null
);

function readMirror(): Map<string, DraftRecord> {
  try {
    const raw = localStorage.getItem(MIRROR_STORAGE_KEY);
    if (!raw) {
      return new Map();
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return new Map();
    }

    const restored = new Map<string, DraftRecord>();
    for (const [scope, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      restored.set(scope, {
        text: typeof value.text === 'string' ? value.text : '',
        queuedMessage: isRecord(value.queuedMessage)
          ? (value.queuedMessage as StoredQueuedMessage)
          : null,
      });
    }
    return restored;
  } catch {
    return new Map();
  }
}

function writeMirror(): void {
  try {
    localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(Object.fromEntries(drafts)));
  } catch {
    // A full localStorage costs the first-paint restore, not the draft: the
    // server copy is authoritative and arrives on hydrate.
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHAT_DRAFTS_CHANGED_EVENT));
  }
}

function flushServerWrites(): void {
  serverWriteTimer = null;
  const scopes = [...pendingScopes].filter(scope => !deliveringScopes.has(scope));
  for (const scope of scopes) {
    pendingScopes.delete(scope);
    const draft = drafts.get(scope);
    const previous = serverWrites.get(scope);
    const save = async () => {
      const response = !draft || isEmptyDraft(draft)
        ? await api.user.deleteDraft(scope)
        : await api.user.saveDraft(scope, { text: draft.text, queuedMessage: draft.queuedMessage });
      if (!response.ok) throw new Error('Failed to save chat draft.');
    };
    const write = previous ? previous.catch(() => {}).then(save) : save();
    serverWrites.set(scope, write);
    void write.catch((error: unknown) => console.error('Failed to save chat draft:', error)).finally(() => {
      if (serverWrites.get(scope) === write) serverWrites.delete(scope);
    });
  }
}

function queueServerWrite(scope: string): void {
  pendingScopes.add(scope);

  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
  }
  serverWriteTimer = setTimeout(flushServerWrites, SERVER_WRITE_DEBOUNCE_MS);
}

function flushServerWritesNow(): void {
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  flushServerWrites();
}

function updateDraft(scope: string, update: Partial<DraftRecord>): void {
  const current = drafts.get(scope) ?? EMPTY_DRAFT;
  const next: DraftRecord = { ...current, ...update };

  if (next.text === current.text && next.queuedMessage === current.queuedMessage) {
    return;
  }

  const nextDrafts = new Map(drafts);
  if (isEmptyDraft(next)) {
    nextDrafts.delete(scope);
  } else {
    nextDrafts.set(scope, next);
  }
  drafts = nextDrafts;

  writeMirror();
  queueServerWrite(scope);
  notifyListeners();
}

/** Reads one scope's composer text, synchronously, for the first render. */
export function readDraftText(scope: string): string {
  return drafts.get(scope)?.text ?? '';
}

export function writeDraftText(scope: string, text: string): void {
  updateDraft(scope, { text });
}

export function readQueuedMessage(scope: string): StoredQueuedMessage | null {
  const queued = drafts.get(scope)?.queuedMessage ?? null;
  if (!queued) {
    return null;
  }

  const attachments = Array.isArray(queued.attachments)
    ? queued.attachments
    : Array.isArray(queued.images)
      ? queued.images
      : [];

  // A queued message with neither text nor attachments has nothing to send.
  return queued.content.trim() || attachments.length > 0
    ? { ...queued, attachments }
    : null;
}

export function writeQueuedMessage(scope: string, message: StoredQueuedMessage): void {
  updateDraft(scope, { queuedMessage: message });
  // Queueing is a send-like action, so persist it before the tab can close.
  flushServerWritesNow();
}

export function clearQueuedMessage(scope: string): void {
  updateDraft(scope, { queuedMessage: null });
  // Editing or cancelling must beat the server's next dispatcher poll.
  flushServerWritesNow();
}

/** Used by the queued card: claim and deliver its saved content without touching new typing. */
export async function steerQueuedMessage(scope: string): Promise<void> {
  if (deliveringScopes.has(scope)) return;
  const queued = readQueuedMessage(scope);
  if (!queued) throw new Error('Queued message was already sent or removed.');
  flushServerWritesNow();
  deliveringScopes.add(scope);
  try {
    // Several serialized saves may precede this click. Bound the entire wait,
    // and never continue to inject the message after that wait has expired.
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([serverWrites.get(scope), new Promise<never>((_resolve, reject) => {
        saveTimer = setTimeout(() => reject(new Error('等待排队消息保存确认超时，请检查连接和会话记录。')), 10_000);
      })]);
    } finally {
      clearTimeout(saveTimer);
    }
    const response = await api.providers.steerSession(scope, queued.content, queued.attachments ?? [], true);
    const body = await response.json();
    if (!response.ok || body?.data?.delivered !== true) {
      const message = body?.error?.message || body?.error || 'Live input could not be confirmed.';
      if (body?.error?.code === 'QUEUE_CHANGED') {
        // Another dispatcher/device owns this message. Do not put it back.
        const snapshot = await api.user.drafts();
        if (!snapshot.ok) throw new Error(message);
        const payload = await snapshot.json();
        const remote = payload.drafts?.find((draft: { scope: string }) => draft.scope === scope);
        updateDraft(scope, { queuedMessage: remote?.queuedMessage ?? null });
      } else {
        updateDraft(scope, { queuedMessage: { ...queued, deliveryError: String(message) } });
      }
      throw new Error(message);
    }
    updateDraft(scope, { queuedMessage: null });
  } catch (error) {
    // A lost receipt can mean delivery succeeded. Pause instead of auto-resending.
    if (readQueuedMessage(scope) === null) throw error;
    const current = readQueuedMessage(scope);
    if (current && !current.deliveryError && current.content === queued.content) {
      updateDraft(scope, { queuedMessage: { ...current, deliveryError: error instanceof Error ? error.message : String(error) } });
    }
    throw error;
  } finally {
    deliveringScopes.delete(scope);
    flushServerWritesNow();
  }
}

/** Subscribes to any draft change; returns the unsubscribe function. */
export function subscribeToChatDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Loads the server's drafts and adopts them as the source of truth.
 *
 * A scope the client has typed into since this page loaded is left alone: the
 * user is looking at that composer right now, and replacing its contents with a
 * staler server copy would delete what they are in the middle of writing.
 */
export async function hydrateChatDrafts(): Promise<void> {
  let serverDrafts: Array<{ scope?: unknown; text?: unknown; queuedMessage?: unknown }> = [];
  const protectedScopes = new Set([...pendingScopes, ...deliveringScopes, ...serverWrites.keys()]);

  try {
    const response = await api.user.drafts();
    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as { drafts?: unknown };
    if (!Array.isArray(payload.drafts)) {
      return;
    }
    serverDrafts = payload.drafts as typeof serverDrafts;
  } catch (error) {
    // Keep the mirror: an offline load must still show what was typed here.
    console.error('Failed to load chat drafts:', error);
    return;
  }

  for (const scope of [...pendingScopes, ...deliveringScopes, ...serverWrites.keys()]) protectedScopes.add(scope);
  const merged = new Map<string, DraftRecord>();
  for (const draft of serverDrafts) {
    const scope = typeof draft.scope === 'string' ? draft.scope : '';
    if (!scope || protectedScopes.has(scope)) {
      continue;
    }

    merged.set(scope, {
      text: typeof draft.text === 'string' ? draft.text : '',
      queuedMessage: isRecord(draft.queuedMessage)
        ? (draft.queuedMessage as StoredQueuedMessage)
        : null,
    });
  }

  // Local edits whose debounced write has not left the browser yet win over
  // the server snapshot. Every other missing scope was deleted remotely and
  // must also disappear from the mirror.
  for (const scope of protectedScopes) {
    const pending = drafts.get(scope);
    if (pending) {
      merged.set(scope, pending);
    }
  }

  drafts = merged;
  writeMirror();
  notifyListeners();
}

/** Drops every cached draft on sign-out, so the next user sees none of them. */
export function resetChatDrafts(): void {
  drafts = new Map();
  pendingScopes.clear();
  serverWrites.clear();
  deliveringScopes.clear();
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  try {
    localStorage.removeItem(MIRROR_STORAGE_KEY);
  } catch {
    // The in-memory copy is already cleared, which is what readers use.
  }
  notifyListeners();
}

// Read at module load rather than on first use, because the composer's initial
// input value is a `useState` initializer that runs before any effect.
if (typeof localStorage !== 'undefined') {
  drafts = readMirror();
}
