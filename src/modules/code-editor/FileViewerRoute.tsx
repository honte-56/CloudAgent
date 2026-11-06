import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import CodeEditor from '@/modules/code-editor/CodeEditor';

/** App's authenticated /file route: durable file links reopen the same viewer without starting an agent. */
export function FileViewerRoute() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useTranslation('codeEditor');
  const projectId = params.get('projectId') || '';
  const path = params.get('path') || '';
  const file = useMemo(() => ({ projectId, path, name: path.split(/[\\/]/).pop() || path }), [projectId, path]);
  if (!projectId || !path) return <div role="alert" className="p-6">{t('filePreview.invalidLink', 'This file link is incomplete.')}</div>;
  return <div className="h-dvh w-full"><CodeEditor key={`${projectId}:${path}`} file={file} isSidebar initialPreview showSettings={false} onClose={() => navigate('/')} /></div>;
}
