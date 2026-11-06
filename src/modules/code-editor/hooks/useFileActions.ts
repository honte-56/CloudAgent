import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import type { CodeEditorFile } from '@/shared/types';

/** File operations for the code-editor's common toolbar, independent of preview support. */
export function useFileActions(file: CodeEditorFile, projectId?: string) {
  const { t } = useTranslation('codeEditor');
  // The active request owns its progress and is cancelled when the file changes.
  const downloadRef = useRef<AbortController | null>(null);
  const [downloading, setDownloading] = useState(false);
  // A download error must stay actionable without replacing the preview.
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // Metadata comes from stat; opening a ZIP must not download it just to show its size.
  const [metadata, setMetadata] = useState<{ size?: number; mimeType?: string } | null>(null);

  useEffect(() => {
    setDownloading(false);
    setDownloadError(null);
    setMetadata(null);
    const controller = new AbortController();
    void (async () => {
      if (!projectId) return;
      try {
        const response = await api.statFiles(projectId, [file.path], { signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json();
        if (!controller.signal.aborted) setMetadata(data.files?.[0] ?? null);
      } catch { /* Metadata failure does not disable download or copying. */ }
    })();
    return () => {
      controller.abort();
      downloadRef.current?.abort();
      downloadRef.current = null;
    };
  }, [projectId, file.path]);

  const download = async () => {
    if (downloadRef.current) return;
    const controller = new AbortController();
    downloadRef.current = controller;
    setDownloading(true);
    setDownloadError(null);
    try {
      if (!projectId) throw new Error(t('filePreview.missingProject', 'Missing project identifier'));
      const response = await api.readFileBlob(projectId, file.path, { signal: controller.signal });
      if (!response.ok) throw new Error(`${t('actions.downloadFailed', 'Download failed')} (${response.status})`);
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Let the browser begin reading before releasing the download URL.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      if (!controller.signal.aborted) setDownloadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (downloadRef.current === controller) {
        downloadRef.current = null;
        setDownloading(false);
      }
    }
  };

  return { download, downloading, downloadError, metadata };
}
