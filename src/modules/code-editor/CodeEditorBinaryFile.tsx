import { Download, File } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { CodeEditorFile } from '@/shared/types';

/** CodeEditor's fallback body; file actions remain in the common header even without a preview. */
export default function CodeEditorBinaryFile({ file, size, downloading, onDownload }: {
  file: CodeEditorFile;
  size?: number;
  downloading: boolean;
  onDownload: () => void;
}) {
  const { t } = useTranslation('codeEditor');
  const sizeLabel = size === undefined ? null : size < 1024 ? `${size} B`
    : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return (
    <div className="flex h-full flex-col items-center justify-center overflow-auto bg-background p-6 text-center">
      <div className="flex max-w-md flex-col items-center gap-4">
        <div className="rounded-full bg-muted p-4"><File className="h-8 w-8 text-muted-foreground" /></div>
        <h3 className="max-w-full break-all text-lg font-medium">{file.name}</h3>
        <p className="text-sm text-muted-foreground">{file.name.split('.').pop()?.toUpperCase()}{sizeLabel ? ` · ${sizeLabel}` : ''}</p>
        <p className="text-sm text-muted-foreground">{t('binaryFile.downloadHint', 'Preview is not available for this file. Download it to open it locally.')}</p>
        <button type="button" disabled={downloading} onClick={onDownload}
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">
          <Download className="h-4 w-4" />{t(downloading ? 'actions.downloading' : 'actions.download', downloading ? 'Downloading...' : 'Download file')}
        </button>
      </div>
    </div>
  );
}
