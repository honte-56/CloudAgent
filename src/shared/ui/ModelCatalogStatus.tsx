import { useTranslation } from 'react-i18next';
import type { ProviderModelsDefinition } from '@/shared/types';

/** Used by chat and settings to expose native catalog failures and an explicit refresh action. */
export function ModelCatalogStatus({ discovery, loading = false, onRefresh }: {
  discovery?: ProviderModelsDefinition['DISCOVERY'];
  loading?: boolean;
  onRefresh?: () => void;
}) {
  const { t } = useTranslation('common');
  return (
    <div className="flex items-center justify-between gap-3 px-2.5 py-2 text-xs text-muted-foreground">
      <span role="status">
        {loading ? t('modelCatalog.loading', { defaultValue: 'Reading models…' })
          : discovery?.status === 'stale'
            ? t('modelCatalog.stale', { defaultValue: 'Refresh failed. Showing the last available list.' })
            : discovery?.status === 'unavailable'
              ? t('modelCatalog.unavailable', { defaultValue: 'Unable to read models. Check the CLI installation and sign-in, then retry.' })
              : null}
      </span>
      {onRefresh && (
        <button type="button" disabled={loading} onClick={onRefresh} className="shrink-0 rounded px-2 py-1 hover:bg-accent disabled:opacity-50">
          {t('modelCatalog.refresh', { defaultValue: 'Refresh models' })}
        </button>
      )}
    </div>
  );
}
