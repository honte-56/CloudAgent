import { useEffect, useRef, useState } from 'react';
import { Check, Code2, Copy, Download, Eye, ExternalLink, Link, Loader2, Maximize2, Minimize2, MoreHorizontal, Save, Settings, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useHref, useInRouterContext } from 'react-router-dom';

import { copyTextToClipboard } from '@/shared/utils';
import type { CodeEditorFile } from '@/shared/types';

// This child is mounted only inside a router. useHref retains reverse-proxy
// basenames, and the link never includes credentials or a temporary blob URL.
function FileLinkAction({ projectId, path, onCopy, compact = false }: { projectId: string; path: string; compact?: boolean; onCopy: (text: string, label: string) => void }) {
  const { t } = useTranslation('codeEditor');
  const href = useHref(`/file?${new URLSearchParams({ projectId, path })}`);
  return <button type="button" role={compact ? undefined : 'menuitem'}
    title={t('actions.copyLink', 'Copy file link')} aria-label={t('actions.copyLink', 'Copy file link')}
    className={compact ? 'hidden h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted sm:flex' : 'flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-muted'}
    onClick={() => onCopy(new URL(href, window.location.origin).href, t('actions.linkCopied', 'File link copied'))}>
    <Link className="h-4 w-4" />{!compact && t('actions.copyLink', 'Copy file link')}
  </button>;
}

/** Common header used by CodeEditor for text, media, unsupported files and load errors. */
export default function CodeEditorHeader({
  file, projectId, isSidebar, isFullscreen, canEdit, canPreview, preview, loading,
  saving, saveSuccess, hasUnsavedChanges, downloading, onTogglePreview, onOpenHtmlPreview,
  onOpenSettings, onDownload, onSave, onToggleFullscreen, onClose,
}: {
  file: CodeEditorFile;
  projectId?: string;
  isSidebar: boolean;
  isFullscreen: boolean;
  canEdit: boolean;
  canPreview: boolean;
  preview: boolean;
  loading: boolean;
  saving: boolean;
  saveSuccess: boolean;
  hasUnsavedChanges: boolean;
  downloading: boolean;
  onTogglePreview: () => void;
  onOpenHtmlPreview?: () => void;
  onOpenSettings?: () => void;
  onDownload: () => void;
  onSave: () => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('codeEditor');
  const inRouter = useInRouterContext();
  // Extra actions collapse into one menu so the toolbar fits narrow/mobile panels.
  const [menuOpen, setMenuOpen] = useState(false);
  // Copy feedback is announced and remains visible after the menu closes.
  const [feedback, setFeedback] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setMenuOpen(false);
    setFeedback(null);
    return () => { if (feedbackTimer.current) clearTimeout(feedbackTimer.current); };
  }, [file.path]);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [menuOpen]);

  const copy = async (value: string, label: string) => {
    const copied = await copyTextToClipboard(value);
    setFeedback(copied ? label : t('actions.copyFailed', 'Copy failed. Please try again.'));
    setMenuOpen(false);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 2500);
  };
  const iconClass = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';
  const previewLabel = preview ? t('actions.editSource', 'Edit source') : t('actions.preview', 'Preview');
  const saveLabel = saveSuccess ? t('actions.saved', 'Saved!') : saving ? t('actions.saving', 'Saving...') : t('actions.save', 'Save');
  return (
    <div className="relative z-20 flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border bg-background px-3 py-2">
      <div className="min-w-0 flex-1 basis-32">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-sm font-medium" title={file.name}>{file.name}</h3>
          {hasUnsavedChanges && <span role="img" aria-label={t('unsavedChanges.indicator', 'Unsaved changes')} className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />}
        </div>
        <div className="flex min-w-0 items-center gap-1">
          <p className="truncate text-xs text-muted-foreground" title={file.path}>{file.path}</p>
          <button type="button" className="shrink-0 rounded p-1 hover:bg-muted" title={t('actions.copyPath', 'Copy file path')} aria-label={t('actions.copyPath', 'Copy file path')}
            onClick={() => void copy(file.path, t('actions.pathCopied', 'File path copied'))}><Copy className="h-3 w-3" /></button>
        </div>
      </div>
      <div className="flex shrink-0 items-center">
        {canPreview && <button type="button" className={iconClass} disabled={loading} onClick={onTogglePreview} title={previewLabel} aria-label={previewLabel} aria-pressed={preview}>
          {preview ? <Code2 className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>}
        <button type="button" className={iconClass} disabled={downloading} onClick={onDownload} title={t('actions.download', 'Download file')} aria-label={t('actions.download', 'Download file')}>
          {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        </button>
        {inRouter && projectId && <FileLinkAction compact projectId={projectId} path={file.path} onCopy={(value, label) => void copy(value, label)} />}
        {canEdit && <button type="button" className={iconClass} disabled={saving || loading} onClick={onSave} title={saveLabel} aria-label={saveLabel}>
          {saveSuccess ? <Check className="h-4 w-4 text-green-600" /> : <Save className="h-4 w-4" />}
        </button>}
        <div ref={menuRef} className="relative">
          <button ref={menuButtonRef} type="button" className={iconClass} onClick={() => setMenuOpen(!menuOpen)} aria-haspopup="menu" aria-expanded={menuOpen} title={t('actions.more', 'More actions')} aria-label={t('actions.more', 'More actions')}><MoreHorizontal className="h-4 w-4" /></button>
          {menuOpen && <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-56 max-w-[85vw] rounded-lg border border-border bg-background p-1 text-sm shadow-lg">
            {inRouter && projectId && <FileLinkAction projectId={projectId} path={file.path} onCopy={(value, label) => void copy(value, label)} />}
            <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-muted" onClick={() => void copy(file.path, t('actions.pathCopied', 'File path copied'))}><Copy className="h-4 w-4" />{t('actions.copyPath', 'Copy file path')}</button>
            {onOpenHtmlPreview && <button type="button" role="menuitem" disabled={loading} className="flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-muted disabled:opacity-40" onClick={() => { setMenuOpen(false); onOpenHtmlPreview(); }}><ExternalLink className="h-4 w-4" />{t('filePreview.openInNewTab', 'Open preview in new tab')}</button>}
            {canEdit && onOpenSettings && <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-muted" onClick={() => { setMenuOpen(false); onOpenSettings(); }}><Settings className="h-4 w-4" />{t('toolbar.settings', 'Editor settings')}</button>}
            {!isSidebar && <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-muted" onClick={() => { setMenuOpen(false); onToggleFullscreen(); }}>{isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}{t(isFullscreen ? 'actions.exitFullscreen' : 'actions.fullscreen', isFullscreen ? 'Exit fullscreen' : 'Fullscreen')}</button>}
          </div>}
        </div>
        <button type="button" className={iconClass} onClick={onClose} title={t('actions.close', 'Close')} aria-label={t('actions.close', 'Close')}><X className="h-4 w-4" /></button>
      </div>
      {feedback && <div role="status" className="w-full text-xs text-muted-foreground">{feedback}</div>}
    </div>
  );
}
