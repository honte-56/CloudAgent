import { FolderPlus, RefreshCw, Search, X, PanelLeftClose } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Input } from '@/shared/ui';
import { cn } from '@/shared/utils';
import { CLOUDCLI_WORDMARK_FONT_FAMILY } from '@/shared/constants';
import { IS_PLATFORM } from '@/shared/utils';
import type { SidebarSearchMode } from '@/shared/types';
import GitHubStarBadge from '@/modules/sidebar/GitHubStarBadge';
import SidebarModeTabs from '@/modules/sidebar/SidebarModeTabs';

const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

const HEADER_ICON_BUTTON =
  'press flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-60';

type SidebarHeaderProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projectsCount: number;
  runningSessionsCount: number;
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  t: TFunction;
};

/** Module-level, not a nested render function, so the wordmark is not remounted on every SidebarHeader render. */
function LogoBlock({ t }: { t: TFunction }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="squircle flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <h1
        className="truncate text-[15px] font-semibold tracking-tight text-foreground"
        style={{ fontFamily: CLOUDCLI_WORDMARK_FONT_FAMILY }}
      >
        {t('app.title')}
      </h1>
    </div>
  );
}

/** Rendered by SidebarContent at the top of the panel for the search box, search-mode tabs, refresh and new-project actions. */
export default function SidebarHeader({
  isPWA,
  isMobile,
  isLoading,
  projectsCount,
  runningSessionsCount,
  archivedSessionsCount,
  isArchivedSessionsLoading,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCollapseSidebar,
  t,
}: SidebarHeaderProps) {
  const showSearchTools = (projectsCount > 0 || runningSessionsCount > 0 || archivedSessionsCount > 0 || isArchivedSessionsLoading) && !isLoading;
  const searchPlaceholder = searchMode === 'conversations'
    ? t('search.conversationsPlaceholder')
    : searchMode === 'archived'
      ? t('search.archivedPlaceholder', 'Search archived sessions...')
      : searchMode === 'running'
        ? t('search.runningPlaceholder', 'Search running sessions...')
        : t('projects.searchPlaceholder');

  // One header for every screen size. The only differences are the collapse
  // button, which a drawer does not need, and the PWA status-bar inset.
  return (
    <div
      className="flex-shrink-0 px-3 pb-2 pt-3"
      style={isPWA && isMobile ? { paddingTop: '16px' } : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        {IS_PLATFORM ? (
          <a
            href="https://cloudcli.ai/dashboard"
            className="flex min-w-0 items-center gap-2.5 transition-opacity hover:opacity-80 active:opacity-70"
            title={t('tooltips.viewEnvironments')}
          >
            <LogoBlock t={t} />
          </a>
        ) : (
          <LogoBlock t={t} />
        )}

        <div className="flex flex-shrink-0 items-center gap-0.5">
          <button
            type="button"
            className={HEADER_ICON_BUTTON}
            onClick={onRefresh}
            disabled={isRefreshing}
            title={t('tooltips.refresh')}
            aria-label={t('tooltips.refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
          </button>
          <button
            type="button"
            className={HEADER_ICON_BUTTON}
            onClick={onCreateProject}
            title={t('tooltips.createProject')}
            aria-label={t('tooltips.createProject')}
          >
            <FolderPlus className="h-4 w-4" />
          </button>
          {!isMobile && (
            <button
              type="button"
              className={HEADER_ICON_BUTTON}
              onClick={onCollapseSidebar}
              title={t('tooltips.hideSidebar')}
              aria-label={t('tooltips.hideSidebar')}
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <GitHubStarBadge />

      {showSearchTools && (
        <div className="mt-3 space-y-2">
          <SidebarModeTabs
            searchMode={searchMode}
            onSearchModeChange={onSearchModeChange}
            runningSessionsCount={runningSessionsCount}
            t={t}
          />
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              type="text"
              placeholder={searchPlaceholder}
              value={searchFilter}
              onChange={(event) => onSearchFilterChange(event.target.value)}
              className="nav-search-input h-10 rounded-full border-0 pl-10 pr-14 text-sm placeholder:text-muted-foreground/60 focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            {searchFilter ? (
              <button
                type="button"
                onClick={onClearSearchFilter}
                aria-label={t('tooltips.clearSearch')}
                className="press absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full hover:bg-accent"
              >
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            ) : (
              <kbd
                aria-hidden
                title={t('tooltips.openCommandPalette')}
                className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-md bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:inline-flex"
              >
                {MOD_KEY}
                <span>K</span>
              </kbd>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
