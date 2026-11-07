import { Settings, ArrowUpCircle, Bug, AlertTriangle } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { ReleaseInfo } from '@/shared/types';

const GITHUB_ISSUES_URL = 'https://github.com/honte-56/CloudAgent/issues/new';
const GITHUB_REPO_URL = 'https://github.com/honte-56/CloudAgent';

const DISCORD_INVITE_URL = 'https://discord.gg/buxwujPNRE';

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

type SidebarFooterProps = {
  updateAvailable: boolean;
  restartRequired: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  currentVersion: string;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  t: TFunction;
};

/** Rendered by SidebarContent at the bottom of the panel for settings, update status and community links. */
export default function SidebarFooter({
  updateAvailable,
  restartRequired,
  releaseInfo,
  latestVersion,
  currentVersion,
  onShowVersionModal,
  onShowSettings,
  t,
}: SidebarFooterProps) {
  // The same footer on every screen size: status banners when there is news,
  // then one row with Settings as the primary action and the community links
  // as icon buttons beside it.
  return (
    <div className="flex-shrink-0 px-3 pb-3 pt-2" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))' }}>
      {/* Restart-required banner: the running server version differs from the
          installed/frontend version (updated but not restarted). */}
      {restartRequired && (
        <div className="squircle mb-2 flex items-center gap-2.5 rounded-2xl bg-amber-500/12 px-3 py-2.5">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-500 dark:text-amber-400" />
          <span className="min-w-0 flex-1 text-xs font-medium text-amber-800 dark:text-amber-300">
            {t('version.restartRequired')}
          </span>
        </div>
      )}

      {updateAvailable && (
        <button
          type="button"
          className="press-soft squircle mb-2 flex w-full items-center gap-3 rounded-2xl bg-primary-container px-3 py-2.5 text-left text-primary-container-foreground"
          onClick={onShowVersionModal}
        >
          <div className="relative flex-shrink-0">
            <ArrowUpCircle className="h-4 w-4" />
            <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {releaseInfo?.title || `v${latestVersion}`}
            </span>
            <span className="text-xs opacity-75">{t('version.updateAvailable')}</span>
          </div>
        </button>
      )}

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="press flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-full bg-foreground/[0.05] px-4 text-foreground hover:bg-foreground/[0.08]"
          onClick={onShowSettings}
        >
          <Settings className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{t('actions.settings')}</span>
        </button>
        <a
          href={GITHUB_ISSUES_URL}
          target="_blank"
          rel="noopener noreferrer"
          title={t('actions.reportIssue')}
          aria-label={t('actions.reportIssue')}
          className="press flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <Bug className="h-4 w-4" />
        </a>
        <a
          href={DISCORD_INVITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          title={t('actions.joinCommunity')}
          aria-label={t('actions.joinCommunity')}
          className="press flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <DiscordIcon className="h-4 w-4" />
        </a>
      </div>

      {/* Version brand line */}
      <div className="pt-2 text-center">
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-muted-foreground/50 transition-colors hover:text-muted-foreground"
        >
          CloudAgent v{currentVersion} – {t('branding.openSource')}
        </a>
      </div>
    </div>
  );
}
