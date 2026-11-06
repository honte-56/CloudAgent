import { useSessionForkingProviders } from '@/shared/hooks/useProviderCapabilities';
import { useForkAction } from '@/modules/sidebar/hooks/useForkAction';
import { memo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Check, CheckSquare, Edit2, GitBranch, Loader2, MoreHorizontal, Square, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Badge, Dialog, DialogContent, DialogTitle, LLMProviderLogo, Tooltip, buttonVariants } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider } from '@/shared/types';
import { PROVIDER_LABELS, createSessionViewModel, formatCompactAge } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';
import { useProviderSessionIdCopy } from '@/modules/sidebar/hooks/useProviderSessionIdCopy';
import SessionOptions from '@/modules/sidebar/SessionOptions';

type SidebarSessionItemProps = {
  project: Project;
  session: SessionWithProvider;
  selectedSession: ProjectSession | null;
  isProcessing: boolean;
  /** The session's turn has ended but the agents, workflows or commands it launched still run. */
  hasBackgroundWork: boolean;
  needsAttention: boolean;
  currentTime: Date;
  /** Resolved for this row, so a keystroke elsewhere does not invalidate it. */
  isEditing: boolean;
  renameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  /** Branches this session into an independent one; absent when its provider cannot. */
  onForkSession?: (session: SessionWithProvider) => void | Promise<void>;
  /** This project's list is in bulk-selection mode: the row acts as a checkbox and hides its options. */
  isSelecting: boolean;
  /** Ticked for the pending bulk delete. Resolved by the list, which never ticks a running row. */
  isChecked: boolean;
  /** Takes the owning projectId so this memoized row binds itself without the list making a closure per row. */
  onToggleSessionSelected: (projectId: string, sessionId: string) => void;
  t: TFunction;
};

/** Rendered by SidebarProjectSessions for one session row, including its rename, copy and delete controls. */
function SidebarSessionItem({
  project,
  session,
  selectedSession,
  isProcessing,
  hasBackgroundWork,
  needsAttention,
  currentTime,
  isEditing,
  renameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  isSelecting,
  isChecked,
  onToggleSessionSelected,
  t,
}: SidebarSessionItemProps) {
  const isCompact = useCompactSidebar();
  const forkableProviders = useSessionForkingProviders();
  const forkAction = useForkAction(onForkSession ? () => onForkSession(session) : undefined);
  const sessionView = createSessionViewModel(session, currentTime, t);
  const isSelected = selectedSession?.id === session.id;
  const compactSessionAge = formatCompactAge(sessionView.sessionTime, currentTime);
  const [isMobileOptionsOpen, setIsMobileOptionsOpen] = useState(false);
  const showAttentionIndicator = needsAttention && !isSelected;
  // Background work takes the recent-activity dot's place: the session is
  // still doing something, which says more than that it was touched lately.
  const showBackgroundIndicator = !showAttentionIndicator && hasBackgroundWork;
  const showRecentIndicator = !showAttentionIndicator && !showBackgroundIndicator && !isProcessing && sessionView.isActive;
  const indicatorLabel = showAttentionIndicator
    ? t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })
    : showBackgroundIndicator
      ? t('tooltips.backgroundWorkIndicator', { defaultValue: 'Background work running' })
      : t('tooltips.activeSessionIndicator');
  const providerLabel = PROVIDER_LABELS[session.__provider];

  // The desktop controls live in SessionOptions, which owns the rename panel and
  // its outside-click dismissal. The mobile rename sits inside the bottom sheet,
  // which owns its own.
  const { copyState, copyLabel, setOptionsOpen, handleCopyAction, isCopyPending, CopyStateIcon } =
    useProviderSessionIdCopy(session.id, providerLabel);

  // Sessions are owned by a project identified by `projectId` (DB primary key)
  // after the projectName → projectId migration.
  const selectMobileSession = () => {
    onProjectSelect(project);
    onSessionSelect(session, project.projectId);
  };

  const saveEditedSession = () => {
    onSaveEditingSession(project.projectId, session.id, renameDraft, session.__provider);
  };

  const requestDeleteSession = () => {
    onDeleteSession(session.id, sessionView.sessionName);
  };

  // A running session cannot be deleted, so it cannot be ticked either; the row
  // still renders, locked, instead of disappearing from the list mid-selection.
  const isSelectable = isSelecting && !isProcessing;
  const toggleSelected = () => {
    onToggleSessionSelected(project.projectId, session.id);
  };
  // Space activates neither the desktop anchor nor the compact div, and Enter
  // only the anchor, so both keys are handled here and tick either row alike.
  const handleSelectionKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!isSelectable || (event.key !== ' ' && event.key !== 'Enter')) {
      return;
    }
    event.preventDefault();
    toggleSelected();
  };
  const SelectionIcon = isChecked ? CheckSquare : Square;
  const selectionIcon = isSelecting ? (
    <SelectionIcon
      className={cn(
        'h-4 w-4 flex-shrink-0',
        isChecked ? 'text-primary' : 'text-muted-foreground',
        !isSelectable && 'opacity-40',
      )}
      aria-hidden="true"
    />
  ) : null;

  const setMobileOptionsOpen = (open: boolean) => {
    setIsMobileOptionsOpen(open);
    setOptionsOpen(open);
    if (!open && isEditing) {
      onCancelEditingSession();
    }
  };

  const startMobileRename = () => {
    onStartEditingSession(project.projectId, session.id, sessionView.sessionName);
  };

  const saveMobileRename = () => {
    saveEditedSession();
    setMobileOptionsOpen(false);
  };

  return (
    <div className="group relative">
      {(showAttentionIndicator || showBackgroundIndicator || showRecentIndicator) && (
        <div className="absolute left-0 top-1/2 -translate-x-1 -translate-y-1/2 transform">
          <Tooltip content={indicatorLabel} position="right">
            <div
              role="status"
              aria-label={indicatorLabel}
              className={cn(
                'h-2 w-2 animate-pulse rounded-full',
                showAttentionIndicator
                  ? 'bg-amber-500'
                  : showBackgroundIndicator
                    ? 'bg-purple-500 dark:bg-purple-400'
                    : 'bg-green-500',
              )}
            />
          </Tooltip>
        </div>
      )}

      {isCompact && (
      <div>
        <div
          role={isSelecting ? 'checkbox' : undefined}
          aria-checked={isSelecting ? isChecked : undefined}
          aria-disabled={isSelecting && !isSelectable ? true : undefined}
          tabIndex={isSelecting ? 0 : undefined}
          className={cn(
            'press-soft squircle relative mx-2 my-0.5 rounded-2xl px-3 py-2.5',
            isSelected
              ? 'bg-primary-container text-primary-container-foreground'
              : isProcessing
                ? 'bg-foreground/[0.04]'
                : 'active:bg-foreground/[0.05]',
            isChecked && 'bg-primary-container ring-1 ring-primary/30',
          )}
          onClick={isSelecting ? (isSelectable ? toggleSelected : undefined) : selectMobileSession}
          onKeyDown={isSelecting ? handleSelectionKeyDown : undefined}
        >
          <div className="flex items-center gap-2">
            {selectionIcon}
            <div
              className={cn(
                'w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0',
                isSelected ? 'bg-card/70' : 'bg-foreground/[0.06]',
              )}
            >
              <LLMProviderLogo provider={session.__provider} className="h-3 w-3" />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div
                  className="min-w-0 flex-1 truncate text-sm font-normal"
                  title={sessionView.sessionName}
                >
                  {sessionView.sessionName}
                </div>
                {isProcessing ? (
                  <span className="ml-auto flex-shrink-0">
                    <Tooltip content={t('tooltips.processingSessionIndicator', 'Processing session')} position="top">
                      <span className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                      </span>
                    </Tooltip>
                  </span>
                ) : compactSessionAge && (
                  <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">{compactSessionAge}</span>
                )}
              </div>
              <div className="mt-0.5 flex items-center">
                {sessionView.messageCount > 0 && (
                  <Badge variant="secondary" className="px-1 py-0 text-xs">
                    {sessionView.messageCount}
                  </Badge>
                )}
              </div>
            </div>

            {!isSelecting && (
              <button
                type="button"
                aria-label={`Session options for ${sessionView.sessionName}`}
                aria-haspopup="dialog"
                aria-expanded={isMobileOptionsOpen}
                className="press ml-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/[0.06]"
                onClick={(event) => {
                  event.stopPropagation();
                  setMobileOptionsOpen(true);
                }}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <Dialog open={isMobileOptionsOpen} onOpenChange={setMobileOptionsOpen}>
          <DialogContent
            aria-describedby="mobile-session-options-description"
            animationClassName="animate-bottom-sheet-content-show motion-reduce:animate-none"
            className="squircle bottom-0 left-0 top-auto max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-4xl border-0 bg-card px-4 pb-safe-area-inset-bottom pt-3 shadow-floating"
          >
            <DialogTitle>Session options</DialogTitle>
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />

            <div className="mb-4 flex items-center gap-3 px-1">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-muted">
                <LLMProviderLogo provider={session.__provider} className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground" title={sessionView.sessionName}>
                  {sessionView.sessionName}
                </p>
                <p id="mobile-session-options-description" className="text-xs text-muted-foreground">
                  {providerLabel} session
                </p>
              </div>
            </div>

            {isEditing ? (
              <div className="mb-3 space-y-2">
                <label htmlFor={`mobile-session-rename-${session.id}`} className="block px-1 text-xs font-medium text-muted-foreground">
                  Session name
                </label>
                <input
                  id={`mobile-session-rename-${session.id}`}
                  type="text"
                  value={renameDraft}
                  onChange={(event) => onRenameDraftChange(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      saveMobileRename();
                    }
                  }}
                  className="w-full rounded-2xl bg-input px-4 py-3 text-foreground outline-none ring-2 ring-transparent focus:ring-ring/50"
                  autoFocus
                  autoComplete="off"
                  // 16px keeps iOS Safari from zooming the viewport on focus.
                  style={{ fontSize: '16px' }}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={saveMobileRename}
                    className="press flex min-h-12 flex-1 items-center justify-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-medium text-primary-foreground"
                  >
                    <Check className="h-5 w-5 flex-shrink-0" />
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={onCancelEditingSession}
                    className="press flex min-h-12 flex-1 items-center justify-center gap-2 rounded-full bg-muted px-4 py-3 text-sm font-medium text-foreground active:bg-accent"
                  >
                    <X className="h-5 w-5 flex-shrink-0" />
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={startMobileRename}
                  className="flex min-h-12 w-full items-center gap-3 rounded-2xl bg-muted px-4 py-3 text-left text-foreground active:bg-accent press-soft"
                >
                  <Edit2 className="h-5 w-5 flex-shrink-0" />
                  <span className="text-sm font-medium">Rename session</span>
                </button>

                <button
                  type="button"
                  onClick={handleCopyAction}
                  disabled={isCopyPending}
                  className={cn(
                    'press-soft flex min-h-12 w-full items-center gap-3 rounded-2xl px-4 py-3 text-left',
                    copyState === 'copied'
                      ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                      : copyState === 'error'
                        ? 'bg-red-500/10 text-red-700 dark:text-red-300'
                        : 'bg-muted text-foreground active:bg-accent',
                  )}
                >
                  {isCopyPending ? (
                    <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <CopyStateIcon className="h-5 w-5 flex-shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{copyLabel}</span>
                    {copyState === 'error' && (
                      <span className="mt-0.5 block text-xs">Tap to try again.</span>
                    )}
                  </span>
                </button>

                {onForkSession && forkableProviders.has(session.__provider) && (
                  <button type="button" disabled={forkAction.pending} onClick={() => { void forkAction.run().then(() => setMobileOptionsOpen(false)); }}
                    className="press-soft flex min-h-12 w-full items-center gap-3 rounded-2xl bg-muted px-4 py-3 text-left text-foreground active:bg-accent disabled:opacity-50">
                    {forkAction.pending ? <Loader2 className="h-5 w-5 animate-spin" /> : <GitBranch className="h-5 w-5" />}
                    <span className="min-w-0"><span className="block text-sm font-medium">{t(forkAction.pending ? 'buttons.forkingSession' : 'buttons.forkSession')}</span>
                      <span className="block text-xs text-muted-foreground">{t('messages.forkCompletedHistory')}</span></span>
                  </button>
                )}
                {!isProcessing && (
                  <button
                    type="button"
                    onClick={() => {
                      setMobileOptionsOpen(false);
                      requestDeleteSession();
                    }}
                    className="press-soft flex min-h-12 w-full items-center gap-3 rounded-2xl px-4 py-3 text-left text-red-600 active:bg-red-500/10 dark:text-red-400"
                  >
                    <Trash2 className="h-5 w-5 flex-shrink-0" />
                    <span className="text-sm font-medium">Archive or delete session</span>
                  </button>
                )}
              </div>
            )}

            {!isEditing && (
              <button
                type="button"
                onClick={() => setMobileOptionsOpen(false)}
                className="press-soft mb-3 mt-2 min-h-11 w-full rounded-full text-sm font-medium text-muted-foreground active:bg-muted"
              >
                Cancel
              </button>
            )}
          </DialogContent>
        </Dialog>
      </div>
      )}

      {!isCompact && (
      <div>
        <a
          href={`/session/${session.id}`}
          role={isSelecting ? 'checkbox' : undefined}
          aria-checked={isSelecting ? isChecked : undefined}
          aria-disabled={isSelecting && !isSelectable ? true : undefined}
          className={cn(
            buttonVariants({ variant: 'ghost' }),
            'press-soft squircle h-auto w-full justify-start rounded-xl px-2 py-2 text-left font-normal',
            isSelecting ? 'pr-2' : 'pr-11',
            isSelected
              ? 'bg-primary-container text-primary-container-foreground hover:bg-primary-container'
              : isProcessing
                ? 'bg-foreground/[0.04] hover:bg-foreground/[0.06]'
                : 'hover:bg-foreground/[0.05]',
            isChecked && 'bg-primary-container ring-1 ring-primary/30',
          )}
          // Left-click keeps in-app navigation; Ctrl/Cmd/middle-click and the
          // native right-click menu use the href to open a new tab/window.
          // While selecting, every click ticks the row instead.
          onClick={(event) => {
            if (isSelecting) {
              event.preventDefault();
              if (isSelectable) {
                toggleSelected();
              }
              return;
            }
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (event.detail > 1) return;
            onSessionSelect(session, project.projectId);
          }}
          onKeyDown={isSelecting ? handleSelectionKeyDown : undefined}
        >
          <div className="flex w-full min-w-0 items-center gap-2">
            {selectionIcon}
            <div
              className={cn(
                'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full',
                isSelected ? 'bg-card/70' : 'bg-foreground/[0.06]',
              )}
            >
              <LLMProviderLogo provider={session.__provider} className="h-3 w-3" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div
                  className="min-w-0 flex-1 truncate text-sm font-normal"
                  title={sessionView.sessionName}
                  onDoubleClick={(event) => {
                    if (isSelecting || isEditing || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    event.stopPropagation();
                    onStartEditingSession(project.projectId, session.id, sessionView.sessionName);
                  }}
                >
                  {sessionView.sessionName}
                </div>
                {isProcessing ? (
                  <span
                    className={cn(
                      'ml-auto flex-shrink-0 transition-opacity duration-200',
                      isEditing ? 'opacity-0' : !isSelecting && 'group-hover:opacity-0',
                    )}
                  >
                    <Tooltip content={t('tooltips.processingSessionIndicator', 'Processing session')} position="top">
                      <span className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                      </span>
                    </Tooltip>
                  </span>
                ) : compactSessionAge && (
                  <span
                    className={cn(
                      'ml-auto flex-shrink-0 text-[11px] text-muted-foreground transition-opacity duration-200',
                      isEditing ? 'opacity-0' : !isSelecting && 'group-hover:opacity-0',
                    )}
                  >
                    {compactSessionAge}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center">
                {sessionView.messageCount > 0 && <Badge variant="secondary" className="px-1 py-0 text-xs">{sessionView.messageCount}</Badge>}
              </div>
            </div>
          </div>
        </a>

        {!isSelecting && (
          <SessionOptions
            className="absolute right-2 top-1/2 -translate-y-1/2 transform transition-all duration-200"
            sessionId={session.id}
            sessionName={sessionView.sessionName}
            provider={session.__provider}
            projectId={project.projectId}
            isProcessing={isProcessing}
            isEditing={isEditing}
            renameDraft={renameDraft}
            onRenameDraftChange={onRenameDraftChange}
            onStartEditingSession={onStartEditingSession}
            onCancelEditingSession={onCancelEditingSession}
            onSaveEditingSession={onSaveEditingSession}
            onDeleteSession={onDeleteSession}
            onFork={onForkSession ? () => onForkSession(session) : undefined}
            t={t}
          />
        )}
      </div>
      )}
    </div>
  );
}

/**
 * Memoized: a websocket session delta re-renders the sidebar roughly every
 * 0.5-2s during a run, and a rename keystroke re-renders it per character.
 *
 * SidebarProjectSessions hands every row but the one being renamed a constant
 * draft, and the session objects come from a per-project cache, so the compare
 * succeeds for the rest. See sidebarRowProps.test.tsx.
 */
export default memo(SidebarSessionItem);
