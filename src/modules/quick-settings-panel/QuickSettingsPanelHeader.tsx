import { Pin, PinOff, Settings2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type QuickSettingsPanelHeaderProps = {
  isPinned: boolean;
  // False on mobile, where the panel is always an overlay and the pin is hidden.
  canPin: boolean;
  onTogglePin: () => void;
  onClose: () => void;
};

/** Rendered by QuickSettingsPanelView as the drawer's title bar with the pin toggle and, while it is an overlay, a close button. */
export default function QuickSettingsPanelHeader({
  isPinned,
  canPin,
  onTogglePin,
  onClose,
}: QuickSettingsPanelHeaderProps) {
  const { t } = useTranslation('settings');
  const pinLabel = isPinned ? t('quickSettings.unpin') : t('quickSettings.pin');

  return (
    <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
      <h3 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <Settings2 className="h-5 w-5 text-muted-foreground" />
        {t('quickSettings.title')}
      </h3>
      <div className="flex items-center gap-1">
        {canPin && (
          <button
            type="button"
            onClick={onTogglePin}
            aria-pressed={isPinned}
            aria-label={pinLabel}
            title={pinLabel}
            className={`press rounded-full p-2 hover:bg-foreground/[0.06] ${isPinned ? 'text-foreground' : 'text-muted-foreground'}`}
          >
            {isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </button>
        )}
        {/* A docked panel is collapsed with the edge handle or unpinned, so the close button is overlay-only. */}
        {!isPinned && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t('quickSettings.close')}
            title={t('quickSettings.close')}
            className="press rounded-full p-2 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
