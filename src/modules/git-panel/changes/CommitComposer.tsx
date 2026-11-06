import { Check, ChevronDown, GitCommit } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ConfirmationRequest } from '@/shared/types';

// Persists commit messages across unmount/remount, keyed by project path
const commitMessageCache = new Map<string, string>();

type CommitComposerProps = {
  isMobile: boolean;
  projectPath: string;
  selectedFileCount: number;
  isHidden: boolean;
  onCommit: (message: string) => Promise<boolean>;
  onRequestConfirmation: (request: ConfirmationRequest) => void;
};

/** Rendered by ChangesView to compose a commit message and commit the selected files. */
export default function CommitComposer({
  isMobile,
  projectPath,
  selectedFileCount,
  isHidden,
  onCommit,
  onRequestConfirmation,
}: CommitComposerProps) {
  const { t } = useTranslation();
  const [commitMessage, setCommitMessageRaw] = useState(() => commitMessageCache.get(projectPath) ?? '');

  const setCommitMessage = (msg: string) => {
    setCommitMessageRaw(msg);
    if (msg) {
      commitMessageCache.set(projectPath, msg);
    } else {
      commitMessageCache.delete(projectPath);
    }
  };

  const [isCommitting, setIsCommitting] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(isMobile);

  const handleCommit = async (message = commitMessage) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage || selectedFileCount === 0 || isCommitting) {
      return false;
    }

    setIsCommitting(true);
    try {
      const success = await onCommit(trimmedMessage);
      if (success) {
        setCommitMessage('');
      }
      return success;
    } finally {
      setIsCommitting(false);
    }
  };

  const requestCommitConfirmation = () => {
    const trimmedMessage = commitMessage.trim();
    if (!trimmedMessage || selectedFileCount === 0 || isCommitting) {
      return;
    }

    onRequestConfirmation({
      type: 'commit',
      message: t('git:composer.confirmCommit', { count: selectedFileCount, message: trimmedMessage }),
      onConfirm: async () => {
        await handleCommit(trimmedMessage);
      },
    });
  };

  return (
    <div
      className={`transition-all duration-300 ease-in-out ${
        isHidden ? 'max-h-0 -translate-y-2 overflow-hidden opacity-0' : 'max-h-96 translate-y-0 opacity-100'
      }`}
    >
      {isMobile && isCollapsed ? (
        <div className="px-4 py-2">
          <button
            onClick={() => setIsCollapsed(false)}
            className="press flex h-10 w-full items-center justify-center gap-2 rounded-full bg-primary-container px-4 text-sm font-medium text-primary-container-foreground hover:brightness-[0.97] dark:hover:brightness-110"
          >
            <GitCommit className="h-4 w-4" />
            <span>{t('git:composer.commitFiles', { count: selectedFileCount })}</span>
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <div className="px-4 py-3">
          {isMobile && (
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">{t('git:composer.title')}</span>
              <button
                onClick={() => setIsCollapsed(true)}
                className="press rounded-full p-1.5 hover:bg-foreground/[0.06]"
              >
                <ChevronDown className="h-4 w-4 rotate-180" />
              </button>
            </div>
          )}

          <textarea
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
            placeholder={t('git:composer.placeholder')}
            className="squircle w-full resize-none rounded-2xl border border-transparent bg-input/70 px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-primary/20"
            rows={3}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void handleCommit();
              }
            }}
          />

          <div className="mt-2 flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {t('git:composer.filesSelected', { count: selectedFileCount })}
            </span>
            <button
              onClick={requestCommitConfirmation}
              disabled={!commitMessage.trim() || selectedFileCount === 0 || isCommitting}
              className="press flex h-9 items-center space-x-1.5 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check className="h-3 w-3" />
              <span>{isCommitting ? t('git:composer.committing') : t('git:composer.commit')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
