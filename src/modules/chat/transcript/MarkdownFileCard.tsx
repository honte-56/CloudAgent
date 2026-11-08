import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadIcon, EyeIcon, FileIcon, Loader2 } from 'lucide-react';

import { api } from '@/shared/api';
import { usePaletteOps } from '@/modules/command-palette';
import {
  formatFileBytes,
  lookupWorkspaceFile,
  type WorkspaceFileInfo,
} from '@/modules/chat/utils/workspaceFileReference';

type MarkdownFileCardProps = {
  projectId: string;
  filePath: string;
  /** What to show while the server is asked, and when the path is not a readable file. */
  fallback: ReactNode;
};

async function fetchFileBlob(projectId: string, filePath: string): Promise<Blob | null> {
  const response = await api.readFileBlob(projectId, filePath);
  return response.ok ? response.blob() : null;
}

/** Used by chat's Markdown renderer to open readable file references in the workspace viewer or download them. */
export default function MarkdownFileCard({ projectId, filePath, fallback }: MarkdownFileCardProps) {
  const { t } = useTranslation('chat');
  const { openFileInEditor } = usePaletteOps();
  // Only promote an inline reference to a card after the server confirms it exists.
  const [info, setInfo] = useState<WorkspaceFileInfo | null>(null);
  // Prevent duplicate downloads and show progress while fetching the original bytes.
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void lookupWorkspaceFile(projectId, filePath).then((answer) => {
      if (!cancelled) {
        setInfo(answer);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, filePath]);

  const name = info?.name ?? filePath.split('/').pop() ?? filePath;

  const download = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const blob = await fetchFileBlob(projectId, filePath);
      if (!blob) return;
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    } catch (error) {
      console.error(`Failed to download "${name}":`, error);
    } finally {
      setDownloading(false);
    }
  }, [downloading, filePath, name, projectId]);

  if (!info?.exists) {
    return <>{fallback}</>;
  }

  const size = formatFileBytes(info.size);

  // Use the same entry point as transcript links, including path resolution,
  // unsaved-edit protection, and the viewer's format-specific controls.
  const openPreview = () => openFileInEditor(filePath);

  return (
    <span className="my-0.5 inline-flex max-w-full items-center gap-2 rounded-lg border border-border/60 bg-card px-2 py-1 align-middle shadow-sm">
      <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <button
        type="button"
        onClick={openPreview}
        className="min-w-0 truncate rounded-sm text-sm font-medium text-foreground hover:text-primary hover:underline"
        title={filePath}
      >
        {name}
      </button>
      {size && <span className="shrink-0 text-xs text-muted-foreground">{size}</span>}
      <button
        type="button"
        onClick={openPreview}
        aria-label={t('fileCard.preview', { name })}
        title={t('fileCard.preview', { name })}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <EyeIcon className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => void download()}
        disabled={downloading}
        aria-label={t('fileCard.download', { name })}
        title={t('fileCard.download', { name })}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DownloadIcon className="h-3.5 w-3.5" />}
      </button>
    </span>
  );
}
