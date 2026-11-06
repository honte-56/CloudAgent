import { useRef, useState } from 'react';
import { GitBranchIcon, Loader2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '@/shared/types';

/** MessageComponent uses this visible, touch-friendly action on user and assistant rows, including attachment-only prompts. */
export function MessageForkButton({ message, onFork }: { message: ChatMessage; onFork: (message: ChatMessage) => void | Promise<void> }) {
  // Shows progress on the clicked row until its independent branch is ready.
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const { t } = useTranslation('chat');
  const title = pending ? t('message.forking') : message.forkAnchorId ? t('message.forkFromTurn') : t('message.forkNotReady');
  return <button type="button" title={title} aria-label={title} disabled={pending || !message.forkAnchorId}
    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    onClick={async () => {
      if (inFlight.current || !message.forkAnchorId) return;
      inFlight.current = true; setPending(true);
      try { await onFork(message); } finally { inFlight.current = false; setPending(false); }
    }}>
    {pending ? <Loader2Icon className="h-3.5 w-3.5 animate-spin" /> : <GitBranchIcon className="h-3.5 w-3.5" />}
  </button>;
}
