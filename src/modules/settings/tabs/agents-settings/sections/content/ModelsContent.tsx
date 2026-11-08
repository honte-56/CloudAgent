import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAgentModels } from '@/modules/settings/hooks/useAgentModels';
import { useModelVisibility } from '@/shared/hooks/useModelVisibility';
import type { LLMProvider } from '@/shared/types';
import { filterVisibleModels } from '@/shared/utils';
import { Button, Input } from '@/shared/ui';

/** Used by settings' AgentCategoryContentSection to choose conversation models for each agent. */
export default function ModelsContent({ provider }: { provider: LLMProvider }) {
  const { t } = useTranslation('settings');
  const { options, status, reload } = useAgentModels(provider);
  const { visibleModels, saveVisibleModels } = useModelVisibility();
  // Keeps search local to this editor without changing which models are selected.
  const [query, setQuery] = useState('');
  // Null means unedited; a draft with a null selection explicitly restores all current and future models.
  const [draft, setDraft] = useState<{ selection: string[] | null } | null>(null);
  // Blocks conflicting edits during saving and exposes confirmed success or a retryable failure.
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const savedSelection = visibleModels[provider];
  const selection = draft ? draft.selection : savedSelection;
  const selectedIds = draft
    ? selection ?? options.map((option) => option.value)
    : filterVisibleModels(options, selection).map((option) => option.value);
  const selected = new Set(selectedIds);
  const selectedCount = options.filter((option) => selected.has(option.value)).length;
  const normalizedQuery = query.trim().toLowerCase();
  const matches = options.filter((option) => (
    `${option.label} ${option.value} ${option.description ?? ''}`.toLowerCase().includes(normalizedQuery)
  ));
  const saving = saveStatus === 'saving';
  const unavailable = Array.isArray(savedSelection)
    && savedSelection.length > 0
    && !options.some((option) => savedSelection.includes(option.value));

  function edit(selection: string[] | null) {
    setDraft({ selection });
    setSaveStatus('idle');
  }

  async function save() {
    if (!draft || selectedCount === 0) return;
    setSaveStatus('saving');
    try {
      await saveVisibleModels(provider, draft.selection);
      setDraft(null);
      setSaveStatus('saved');
    } catch {
      setSaveStatus('error');
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">{t('models.title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('models.description')}</p>
      </div>
      {status === 'loading' && <p role="status" className="text-sm text-muted-foreground">{t('models.loading')}</p>}
      {status === 'error' && (
        <div role="alert" className="flex items-center justify-between gap-3 text-sm text-destructive">
          <span>{t('models.loadFailed')}</span>
          <Button variant="outline" onClick={reload}>{t('models.retry')}</Button>
        </div>
      )}
      {status === 'ready' && options.length === 0 && <p className="text-sm text-muted-foreground">{t('models.empty')}</p>}
      {status === 'ready' && options.length > 0 && (
        <>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('models.search')}
            aria-label={t('models.search')}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground">{t('models.count', { selected: selectedCount, total: options.length })}</span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" disabled={saving} onClick={() => edit(null)}>{t('models.selectAll')}</Button>
              <Button variant="ghost" size="sm" disabled={saving} onClick={() => edit([])}>{t('models.clear')}</Button>
            </div>
          </div>
          {unavailable && <p role="status" className="text-sm text-muted-foreground">{t('models.unavailable')}</p>}
          <div className="max-h-80 overflow-y-auto rounded-xl border border-border/60 bg-card">
            {matches.map((option) => (
              <label key={option.value} className="flex cursor-pointer items-center gap-3 border-b border-border/40 px-3 py-3 last:border-b-0 hover:bg-accent/50">
                <input
                  type="checkbox"
                  checked={selected.has(option.value)}
                  disabled={saving}
                  onChange={(event) => edit(event.target.checked
                    ? [...selectedIds, option.value]
                    : selectedIds.filter((id) => id !== option.value))}
                  className="h-4 w-4 shrink-0 accent-primary"
                />
                <span className="min-w-0">
                  <span className="block break-words text-sm font-medium text-foreground">{option.label || option.value}</span>
                  <span className="block break-all text-xs text-muted-foreground">{option.value}</span>
                </span>
              </label>
            ))}
            {matches.length === 0 && <p className="p-4 text-sm text-muted-foreground">{t('models.noResults')}</p>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm" aria-live="polite">
              {selectedCount === 0 && <span className="text-destructive">{t('models.minimum')}</span>}
              {saveStatus === 'error' && <span role="alert" className="text-destructive">{t('models.saveFailed')}</span>}
              {saveStatus === 'saved' && <span className="text-muted-foreground">{t('models.saved')}</span>}
            </div>
            <Button disabled={!draft || selectedCount === 0 || saving} onClick={() => void save()}>
              {saving ? t('models.saving') : t('models.save')}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
