import { PanelLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useMobileMenuHandlers } from '@/modules/project-workspace/hooks/useMobileMenuHandlers';

type MobileMenuButtonProps = {
  onMenuClick: () => void;
};

/** Rendered by WorkspaceHeader and WorkspaceStateView to open the sidebar drawer on mobile. */
export default function MobileMenuButton({ onMenuClick }: MobileMenuButtonProps) {
  const { t } = useTranslation();
  const { handleMobileMenuClick, handleMobileMenuTouchEnd } = useMobileMenuHandlers(onMenuClick);

  return (
    <button
      type="button"
      onClick={handleMobileMenuClick}
      onTouchEnd={handleMobileMenuTouchEnd}
      className="press pwa-menu-button flex h-10 w-10 flex-shrink-0 touch-manipulation items-center justify-center rounded-full text-foreground/80 hover:bg-accent hover:text-foreground"
      aria-label={t('misc.openMenu')}
    >
      <PanelLeft className="h-5 w-5" strokeWidth={1.8} />
    </button>
  );
}
