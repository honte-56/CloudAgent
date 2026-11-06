import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/shared/api';
import type { NativeQueuedMessage } from '@/shared/types';

/** Used by the composer to display provider-owned queue entries and await each CLI mutation. */
export function useNativeMessageQueue(sessionId: string | null, enabled: boolean, running: boolean) {
  // The visible snapshot comes from the CLI; it is never persisted into the single draft slot.
  const [snapshot, setSnapshot] = useState<{ sessionId: string | null; messages: NativeQueuedMessage[] }>({ sessionId, messages: [] });
  // Prevents repeated edit/delete/send-now operations on a pending native request.
  const [busyId, setBusyId] = useState<string | null>(null);
  const activeRef = useRef(sessionId);
  activeRef.current = sessionId;
  const readVersionRef = useRef(0);
  const mutationsRef = useRef(new Set<string>());
  const pendingRequestsRef = useRef(new Map<string, string>());
  const refresh = useCallback(async () => {
    if (!sessionId || !enabled) return;
    const version = ++readVersionRef.current;
    const response = await api.providers.nativeQueue(sessionId);
    if (!response.ok) return;
    const body = await response.json();
    if (activeRef.current === sessionId && readVersionRef.current === version) {
      setSnapshot({ sessionId, messages: body.data?.messages ?? [] });
    }
  }, [sessionId, enabled]);
  const messages = snapshot.sessionId === sessionId ? snapshot.messages : [];
  useEffect(() => {
    void refresh().catch(() => {});
    if (!running && messages.length === 0) return;
    const timer = setInterval(() => { void refresh().catch(() => {}); }, 2500);
    return () => clearInterval(timer);
  }, [refresh, running, messages.length]);
  const enqueue = useCallback(async (content: string, attachments: unknown[]) => {
    if (!sessionId) throw new Error('No session selected');
    const requestKey = JSON.stringify([sessionId, content, attachments]);
    const requestId = pendingRequestsRef.current.get(requestKey) ?? crypto.randomUUID();
    pendingRequestsRef.current.set(requestKey, requestId);
    const response = await api.providers.enqueueNativeMessage(sessionId, content, attachments, requestId);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? body.error ?? 'CLI did not accept the queued message.');
    pendingRequestsRef.current.delete(requestKey);
    if (activeRef.current === sessionId) {
      ++readVersionRef.current;
      setSnapshot(previous => ({ sessionId, messages: [...(previous.sessionId === sessionId ? previous.messages.filter(entry => entry.id !== body.data.message.id) : []), body.data.message] }));
    }
    void refresh().catch(() => {});
  }, [sessionId, refresh]);
  const mutate = useCallback(async (id: string, sendNow: boolean) => {
    if (!sessionId) return false;
    const key = `${sessionId}:${id}`;
    if (mutationsRef.current.has(key)) return false;
    mutationsRef.current.add(key);
    setBusyId(id);
    try {
      const response = sendNow ? await api.providers.sendNativeQueuedMessage(sessionId, id) : await api.providers.deleteNativeQueuedMessage(sessionId, id);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? body.error ?? 'CLI queue operation failed.');
      const changed = sendNow || Boolean(body.data?.deleted);
      if (changed && activeRef.current === sessionId) {
        ++readVersionRef.current;
        setSnapshot(previous => previous.sessionId !== sessionId ? previous : { sessionId, messages: previous.messages.filter(entry => entry.id !== id) });
      }
      void refresh().catch(() => {});
      return changed;
    } finally { mutationsRef.current.delete(key); setBusyId(null); }
  }, [sessionId, refresh]);
  return { messages, busyId, enqueue, mutate };
}
