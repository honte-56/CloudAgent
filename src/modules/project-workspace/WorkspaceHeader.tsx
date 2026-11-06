import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type { AppTab, Project, ProjectSession } from '@/shared/types';
import { cn } from '@/shared/utils';
import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import WorkspaceConnectionStatus from '@/modules/project-workspace/WorkspaceConnectionStatus';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';
import WorkspaceTitle from '@/modules/project-workspace/WorkspaceTitle';

type WorkspaceHeaderProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
  isMobile: boolean;
  onMenuClick: () => void;
  /** Persists a new title for a session; resolves false when the backend refuses it. */
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
};

/** Rendered by WorkspaceMain to show the workspace title and chat connection status alongside the scrollable tab bar. */
export default function WorkspaceHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  shouldShowBrowserTab,
  isMobile,
  onMenuClick,
  onRenameSession,
}: WorkspaceHeaderProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const hasOverflow = canScrollLeft || canScrollRight;

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();

    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);

    return () => observer.disconnect();
  }, [updateScrollState]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

      const maxScrollLeft = el.scrollWidth - el.clientWidth;
      const canMove = event.deltaY < 0 ? el.scrollLeft > 0 : el.scrollLeft < maxScrollLeft;
      if (!canMove) return;

      event.preventDefault();
      const lineMultiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 20 : 1;
      el.scrollBy({ left: event.deltaY * lineMultiplier, behavior: 'auto' });
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const activeTabElement = scrollRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      activeTabElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      updateScrollState();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, updateScrollState]);

  const scrollTabs = (direction: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(180, el.clientWidth * 0.65), behavior: 'smooth' });
  };

  // One row on every screen size: what you are looking at on the left, where
  // else you can go on the right. Phones get the same bar with icon-only tabs.
  return (
    <header className="pwa-header-safe relative z-10 flex-shrink-0 bg-background/90 px-2 backdrop-blur-md supports-[backdrop-filter]:bg-background/75 sm:px-3">
      <div className="flex h-14 min-w-0 items-center gap-1.5 sm:gap-3">
        {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <WorkspaceTitle
            activeTab={activeTab}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            shouldShowTasksTab={shouldShowTasksTab}
            onRenameSession={onRenameSession}
          />
          <WorkspaceConnectionStatus />
        </div>

        <div className="relative min-w-0 max-w-[60%] flex-shrink sm:max-w-[min(70%,44rem)]">
          {canScrollLeft && (
            <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 rounded-l-full bg-gradient-to-r from-background via-background/80 to-transparent" />
          )}
          <div
            ref={scrollRef}
            onScroll={updateScrollState}
            className={cn(
              'scrollbar-hide max-w-full scroll-smooth overflow-x-auto overscroll-x-contain rounded-full [-webkit-overflow-scrolling:touch]',
              hasOverflow && 'sm:px-8',
            )}
          >
            <WorkspaceTabs
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              shouldShowTasksTab={shouldShowTasksTab}
              shouldShowBrowserTab={shouldShowBrowserTab}
            />
          </div>
          {canScrollRight && (
            <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 rounded-r-full bg-gradient-to-l from-background via-background/80 to-transparent" />
          )}

          {canScrollLeft && (
            <button
              type="button"
              onClick={() => scrollTabs(-1)}
              aria-label={t('navigation.scrollTabsLeft', { defaultValue: 'Scroll tabs left' })}
              className="press absolute left-0.5 top-1/2 z-20 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-card text-muted-foreground shadow-raised outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 sm:flex"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          {canScrollRight && (
            <button
              type="button"
              onClick={() => scrollTabs(1)}
              aria-label={t('navigation.scrollTabsRight', { defaultValue: 'Scroll tabs right' })}
              className="press absolute right-0.5 top-1/2 z-20 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-card text-muted-foreground shadow-raised outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 sm:flex"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
