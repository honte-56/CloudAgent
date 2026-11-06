import { randomUUID } from 'node:crypto';
import { sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';
import type { SessionExecutionOwner } from '@/shared/index.js';

/** Used by provider runtimes and the terminal gateway to keep one executor per native conversation, including aliases and reconnects. */
export function createSessionExecutionRegistry(resolveNativeId: (sessionId: string) => string | null) {
  type Entry = {
    owner: SessionExecutionOwner;
    nativeId: string | null;
    stop(): Promise<void> | void;
    exited: Promise<void>;
    release(): void;
    stopping?: Promise<void>;
  };
  const entries = new Map<string, Entry>();
  const find = (sessionId: string, provider?: string, nativeId?: string | null) => {
    const native = nativeId ?? resolveNativeId(sessionId);
    return [...entries.values()].find(entry => {
      if (provider && entry.owner.provider !== provider) return false;
      // Keep the launch id reserved until exit, and also resolve the current
      // native id after a replay/fork changed the persisted mapping. Raw native
      // ids still work after their watcher-created duplicate row was merged.
      const aliases = [entry.owner.sessionId, entry.nativeId, resolveNativeId(entry.owner.sessionId)];
      return aliases.includes(sessionId) || Boolean(native && aliases.includes(native));
    });
  };
  return {
    get(sessionId: string, provider?: string, nativeId?: string | null): SessionExecutionOwner | null {
      const entry = find(sessionId, provider, nativeId);
      return entry ? { ...entry.owner } : null;
    },
    claim(input: { sessionId: string; provider: string; kind: SessionExecutionOwner['kind']; nativeId?: string | null; stop(): Promise<void> | void }) {
      const current = find(input.sessionId, input.provider, input.nativeId);
      if (current) throw new AppError(
        current.owner.kind === 'terminal'
          ? 'This conversation is running in the terminal. Take over in chat to continue here; your draft is kept.'
          : 'This conversation is running in chat. Take over in the terminal to switch without creating a second instance.',
        { code: 'SESSION_OWNED', statusCode: 409 });
      let exited!: () => void;
      const owner: SessionExecutionOwner = { id: randomUUID(), sessionId: input.sessionId, provider: input.provider, kind: input.kind, stopping: false };
      const entry: Entry = {
        owner, nativeId: input.nativeId ?? resolveNativeId(input.sessionId), stop: input.stop,
        exited: new Promise<void>(resolve => { exited = resolve; }),
        release() {
          if (entries.get(owner.id) === entry) entries.delete(owner.id);
          exited();
        },
      };
      entries.set(owner.id, entry);
      return { owner: { ...owner }, release: entry.release };
    },
    async stop(sessionId: string, ownerId: string): Promise<void> {
      const entry = find(sessionId);
      if (!entry) return;
      if (entry.owner.id !== ownerId) throw new AppError('The session owner changed. Refresh before taking over.', { code: 'OWNER_CHANGED', statusCode: 409 });
      if (entry.stopping) return entry.stopping;
      entry.owner.stopping = true;
      // A timeout never drops ownership: starting another CLI before exit would
      // recreate the exact conflict this registry prevents.
      entry.stopping = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(() => entry.stop()).then(() => entry.exited),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError('The previous process has not exited yet. Its ownership is retained; retry takeover.', { code: 'OWNER_STOP_TIMEOUT', statusCode: 409 })), 10_000); }),
          ]);
        } finally {
          clearTimeout(timer);
          entry.owner.stopping = false;
          entry.stopping = undefined;
        }
      })();
      return entry.stopping;
    },
  };
}

/** Shared by Providers and WebSocket; ownership spans foreground replies, background work and disconnected terminal sockets. */
export const sessionExecutionService = createSessionExecutionRegistry(sessionId => {
  // Runtime calls with no stored app session (standalone tools) still use their
  // explicit native id. Normal requests reach this after database startup.
  try { return sessionsDb.getSessionById(sessionId)?.provider_session_id ?? null; }
  catch { return null; }
});
