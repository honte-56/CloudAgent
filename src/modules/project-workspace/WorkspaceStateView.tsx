import { Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';

type WorkspaceStateViewProps = {
  mode: 'loading' | 'empty';
  isMobile: boolean;
  onMenuClick: () => void;
};

/** Rendered by WorkspaceMain instead of the workspace while projects load or when none is selected. */
export default function WorkspaceStateView({ mode, isMobile, onMenuClick }: WorkspaceStateViewProps) {
  const { t } = useTranslation();

  const isLoading = mode === 'loading';

  return (
    <div className="flex h-full flex-col">
      {isMobile && (
        <div className="pwa-header-safe flex h-14 flex-shrink-0 items-center px-2">
          <MobileMenuButton onMenuClick={onMenuClick} />
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center text-muted-foreground">
            <div className="mx-auto mb-4 h-10 w-10">
              <div
                className="h-full w-full rounded-full border-[3px] border-muted border-t-primary"
                style={{
                  animation: 'spin 1s linear infinite',
                  WebkitAnimation: 'spin 1s linear infinite',
                  MozAnimation: 'spin 1s linear infinite',
                }}
              />
            </div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">{t('mainContent.loading')}</h2>
            <p className="text-sm">{t('mainContent.settingUpWorkspace')}</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="mx-auto max-w-md animate-rise-in px-6 text-center">
            <div className="squircle mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-3xl bg-primary-container text-primary-container-foreground">
              <Folder className="h-7 w-7" />
            </div>
            <h2 className="mb-2 text-xl font-semibold text-foreground">{t('mainContent.chooseProject')}</h2>
            <p className="mb-5 text-sm leading-relaxed text-muted-foreground">{t('mainContent.selectProjectDescription')}</p>
            <div className="squircle rounded-2xl bg-muted px-4 py-3">
              <p className="text-sm text-muted-foreground">
                <strong>{t('mainContent.tip')}:</strong> {isMobile ? t('mainContent.createProjectMobile') : t('mainContent.createProjectDesktop')}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
