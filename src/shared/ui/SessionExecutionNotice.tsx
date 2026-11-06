import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/shared/api';

type Owner = { id: string; kind: 'chat' | 'terminal'; stopping: boolean };

/** Chat and Shell share this explicit handoff action; viewing another tab never stops work or starts a duplicate CLI. */
export function SessionExecutionNotice({ sessionId, target, onReleased }: {
  sessionId: string | null | undefined;
  target: Owner['kind'];
  onReleased?: () => void;
}) {
  const { t } = useTranslation('common');
  // Ownership lives on the server; this snapshot renders the handoff action.
  const [owner, setOwner] = useState<Owner | null>(null);
  // Prevent a second handoff while the old process is shutting down.
  const [busy, setBusy] = useState(false);
  // A failed handoff keeps the owner and draft intact and explains the retry.
  const [error, setError] = useState<string | null>(null);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  useEffect(() => {
    setOwner(null); setError(null); setBusy(false);
    if (!sessionId) return;
    let disposed = false;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const response = await api.providers.sessionExecution(sessionId);
        if (!response.ok) return;
        const body = await response.json();
        if (!disposed) setOwner(body.data?.owner ?? null);
      } catch { /* Connection status is handled by the enclosing chat/shell. */ }
      finally { checking = false; }
    };
    void check();
    const poll = window.setInterval(() => { void check(); }, 5000);
    window.addEventListener('focus', check);
    window.addEventListener('session-execution-changed', check);
    return () => { disposed = true; window.clearInterval(poll); window.removeEventListener('focus', check); window.removeEventListener('session-execution-changed', check); };
  }, [sessionId]);

  if (!owner || owner.kind === target) return null;
  const takeover = async () => {
    if (!sessionId || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await api.providers.releaseSessionExecution(sessionId, owner.id);
      const body = await response.json();
      if (!response.ok) throw new Error((typeof body.error === 'string' ? body.error : body.error?.message) || body.message || t('execution.failed'));
      if (currentSession.current !== sessionId) return;
      setOwner(null);
      onReleased?.();
      window.dispatchEvent(new Event('session-execution-changed'));
    } catch (failure) {
      if (currentSession.current === sessionId) setError(failure instanceof Error ? failure.message : t('execution.failed'));
    } finally { if (currentSession.current === sessionId) setBusy(false); }
  };
  return (
    <div role="status" className="m-2 rounded-lg border border-border bg-muted/50 p-3 text-sm">
      <p className="font-medium">{t(owner.kind === 'terminal' ? 'execution.inTerminal' : 'execution.inChat')}</p>
      <p className="mt-1 text-muted-foreground">{t('execution.explanation')}</p>
      {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
      <button type="button" disabled={busy || owner.stopping} onClick={() => { void takeover(); }}
        className="mt-2 rounded-md border border-border bg-background px-3 py-1.5 font-medium hover:bg-accent disabled:opacity-50">
        {t(busy || owner.stopping ? 'execution.stopping' : target === 'chat' ? 'execution.toChat' : 'execution.toTerminal')}
      </button>
    </div>
  );
}
