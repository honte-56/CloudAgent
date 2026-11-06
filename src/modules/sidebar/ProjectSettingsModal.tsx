import { useEffect, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '@/shared/api';
import type { Project, GithubTokenCredential } from '@/shared/types';
import { Button, Input } from '@/shared/ui';

type Props = { project: Project; onClose(): void; onSaved(project: Project): void };

/** Used by Sidebar to edit project metadata, credential binding and directory in one save. */
export default function ProjectSettingsModal({ project, onClose, onSaved }: Props) {
  const { t } = useTranslation('common');
  // Hold the editable settings together while the stored credential loads.
  const [form, setForm] = useState({ displayName: project.displayName || '', path: project.fullPath || project.path || '', credentialId: '' });
  // Credential metadata populates the selector; secrets never enter this dialog.
  const [tokens, setTokens] = useState<GithubTokenCredential[]>([]);
  // Prevent saving an unloaded binding and double submission.
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'failed'>('loading');
  // Keep server rejection details visible while preserving all unsaved fields.
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [bindingResponse, tokenResponse] = await Promise.all([api.projectGithubCredential(project.projectId), api.settings.credentials('github_token')]);
        if (!bindingResponse.ok || !tokenResponse.ok) throw new Error(t('projectSettings.loadError'));
        const [binding, credentials] = await Promise.all([bindingResponse.json(), tokenResponse.json()]);
        if (!cancelled) {
          setTokens(credentials.credentials || []);
          setForm(previous => ({ ...previous, credentialId: binding.credentialId == null ? '' : String(binding.credentialId) }));
          setStatus('ready');
        }
      } catch (err) { if (!cancelled) { setError(err instanceof Error ? err.message : t('projectSettings.loadError')); setStatus('failed'); } }
    })();
    return () => { cancelled = true; };
  }, [project.projectId, t]);
  const save = async () => {
    setStatus('saving'); setError('');
    try {
      const response = await api.updateProjectSettings(project.projectId, { ...form, credentialId: form.credentialId ? Number(form.credentialId) : null });
      const result = await response.json();
      if (!response.ok) {
        const code = result.error?.code;
        throw new Error(code && t(`projectSettings.errors.${code}`, { defaultValue: '' }) || result.error?.message || result.error || t('projectSettings.saveError'));
      }
      onSaved({ ...project, ...result.project });
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : t('projectSettings.saveError')); setStatus('ready'); }
  };
  const unavailable = Boolean(form.credentialId) && !tokens.some(token => String(token.id) === form.credentialId && token.is_active);
  return <div className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-[hsl(var(--scrim))] p-4 backdrop-blur-[2px]">
    <div role="dialog" aria-modal="true" aria-label={t('projectSettings.title')} className="squircle animate-pop-in max-h-[90dvh] w-full max-w-lg space-y-4 overflow-y-auto rounded-3xl border border-border/50 bg-card p-5 text-foreground shadow-floating">
      <div className="flex items-center justify-between"><h3 className="text-lg font-semibold">{t('projectSettings.title')}</h3><button aria-label={t('projectSettings.close')} disabled={status === 'saving'} onClick={onClose}><X className="h-5 w-5" /></button></div>
      <label className="block space-y-1 text-sm"><span>{t('projectSettings.name')}</span><Input value={form.displayName} disabled={status === 'saving'} onChange={event => setForm({ ...form, displayName: event.target.value })} /></label>
      <label className="block space-y-1 text-sm"><span>{t('projectSettings.directory')}</span><Input value={form.path} disabled={status === 'saving'} onChange={event => setForm({ ...form, path: event.target.value })} /></label>
      <p className="text-xs text-muted-foreground">{t('projectSettings.directoryHelp')}</p>
      <label className="block space-y-1 text-sm"><span>{t('projectSettings.credential')}</span><select className="w-full rounded-md border border-input bg-background px-3 py-2" value={form.credentialId} disabled={status !== 'ready'} onChange={event => setForm({ ...form, credentialId: event.target.value })}>
        <option value="">{t('projectSettings.none')}</option>
        {tokens.map(token => <option key={token.id} value={token.id} disabled={!token.is_active}>{token.credential_name}</option>)}
        {form.credentialId && !tokens.some(token => String(token.id) === form.credentialId) && <option value={form.credentialId} disabled>{t('projectSettings.unavailable')}</option>}
      </select></label>
      {unavailable && status === 'ready' && <p className="text-xs text-destructive">{t('projectSettings.unavailable')}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button onClick={save} disabled={status !== 'ready' || unavailable || !form.path.trim()}>{status === 'loading' || status === 'saving' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{t('projectSettings.save')}</Button>
    </div>
  </div>;
}
