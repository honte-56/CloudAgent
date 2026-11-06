import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/shared/api';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';
import { Button, Input } from '@/shared/ui';

/** Used by the global Settings dialog to configure defaults for all new projects. */
export default function ProjectsSettingsTab() {
  const { t } = useTranslation('common');
  // Keep edits local until the user explicitly saves their default.
  const [directory, setDirectory] = useState(() => readUserPreference('defaultProjectDirectory', ''));
  // Report persistence failures instead of implying the setting was saved.
  const [status, setStatus] = useState<'ready' | 'saving' | 'saved' | 'error'>('ready');
  const save = async () => {
    setStatus('saving');
    try {
      const response = await api.user.savePreferences({ defaultProjectDirectory: directory.trim() });
      if (!response.ok) throw new Error('Save failed');
      writeUserPreference('defaultProjectDirectory', directory.trim());
      setStatus('saved');
    } catch { setStatus('error'); }
  };
  return <div className="space-y-2 rounded-lg border border-border p-3">
    <label className="block space-y-1 text-sm"><span>{t('projectSettings.defaultDirectory')}</span>
      <Input value={directory} disabled={status === 'saving'} placeholder="/srv/projects" onChange={event => { setDirectory(event.target.value); setStatus('ready'); }} />
    </label>
    <p className="text-xs text-muted-foreground">{t('projectSettings.defaultDirectoryHelp')}</p>
    <Button size="sm" variant="outline" disabled={status === 'saving'} onClick={save}>{t('projectSettings.saveDefault')}</Button>
    {status === 'saved' && <p role="status" className="text-xs text-muted-foreground">{t('projectSettings.saved')}</p>}
    {status === 'error' && <p role="alert" className="text-xs text-destructive">{t('projectSettings.saveError')}</p>}
  </div>;
}
