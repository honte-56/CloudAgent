import { memo, useCallback, useEffect, useRef } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

import { useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { useSidebarDrawerGesture } from '@/modules/project-workspace/hooks/useSidebarDrawerGesture';
import { Sidebar } from '@/modules/sidebar';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import {
  SIDEBAR_WIDTH_KEYBOARD_STEP,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  useSidebarWidth,
} from '@/shared/hooks/useSidebarWidth';
import type { ProjectWorkspaceShellProps } from '@/shared/types';

type ProjectSidebarRegionProps = Pick<ProjectWorkspaceShellProps, 'isMobile'> & {
  /** The workspace root, which carries the drawer's progress for the main layer to follow. */
  motionRootRef: RefObject<HTMLDivElement | null>;
};

/** Rendered by ProjectWorkspaceShell to host the sidebar module, docked on desktop and as a drawer on mobile. */
function ProjectSidebarRegion({
  isMobile,
  motionRootRef,
}: ProjectSidebarRegionProps) {
  const { t } = useTranslation('common');
  const { sidebarOpen, setSidebarOpen, sidebarSharedProps } = useProjectSidebarState();
  const { width: sidebarWidth, setWidth: setSidebarWidth, resetWidth: resetSidebarWidth } = useSidebarWidth();
  // Hide sidebar leaves a 48px icon rail behind, which sizes itself — the stored
  // width and the drag handle only apply while the full sidebar is on screen.
  const { sidebarVisible } = useUiPreferences();
  const isSidebarResizable = !isMobile && sidebarVisible;
  // Drag origin; null while no resize is in progress.
  const resizeOriginRef = useRef<{ pointerX: number; width: number } | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const pendingWidthRef = useRef<number>(sidebarWidth);
  const drawerPanelRef = useRef<HTMLDivElement>(null);

  useSidebarDrawerGesture({
    enabled: isMobile,
    open: sidebarOpen,
    setOpen: setSidebarOpen,
    rootRef: motionRootRef,
    panelRef: drawerPanelRef,
  });

  // Escape closes the drawer the same way a tap on the scrim does.
  useEffect(() => {
    if (!isMobile || !sidebarOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isMobile, sidebarOpen, setSidebarOpen]);

  const handleBackdropClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setSidebarOpen(false);
  }, [setSidebarOpen]);

  // Sidebar resizing (desktop only). Pointer capture keeps the drag alive when
  // the cursor leaves the 4px handle, and the width is only written to storage
  // once the pointer is released.
  const handleResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeOriginRef.current = { pointerX: event.clientX, width: sidebarWidth };
    pendingWidthRef.current = sidebarWidth;
    document.body.style.userSelect = 'none';
  }, [sidebarWidth]);

  const handleResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = resizeOriginRef.current;
    if (!origin) return;

    pendingWidthRef.current = origin.width + (event.clientX - origin.pointerX);
    if (resizeFrameRef.current !== null) return;
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      setSidebarWidth(pendingWidthRef.current, false);
    });
  }, [setSidebarWidth]);

  const handleResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeOriginRef.current) return;
    resizeOriginRef.current = null;

    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.userSelect = '';
    setSidebarWidth(pendingWidthRef.current);
  }, [setSidebarWidth]);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setSidebarWidth(sidebarWidth - SIDEBAR_WIDTH_KEYBOARD_STEP);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setSidebarWidth(sidebarWidth + SIDEBAR_WIDTH_KEYBOARD_STEP);
    } else if (event.key === 'Home') {
      event.preventDefault();
      resetSidebarWidth();
    }
  }, [resetSidebarWidth, setSidebarWidth, sidebarWidth]);

  // Going mobile or collapsing mid-drag unmounts the separator, so the pointerup
  // that would have ended the drag never arrives: the body stays unselectable, and
  // the live origin would make a plain hover resize the sidebar once it is back.
  useEffect(() => {
    if (isSidebarResizable) return;
    resizeOriginRef.current = null;
    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
    document.body.style.userSelect = '';
  }, [isSidebarResizable]);

  // A drag interrupted by an unmount must not leave the page unselectable.
  useEffect(() => () => {
    if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
    document.body.style.userSelect = '';
  }, []);

  if (!isMobile) {
    return (
      <div
        className="relative h-full flex-shrink-0"
        style={isSidebarResizable ? { width: sidebarWidth } : undefined}
      >
        <Sidebar {...sidebarSharedProps} />
        {isSidebarResizable && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('versionUpdate.ariaLabels.resizeSidebar')}
            aria-valuenow={sidebarWidth}
            aria-valuemin={SIDEBAR_WIDTH_MIN}
            aria-valuemax={SIDEBAR_WIDTH_MAX}
            tabIndex={0}
            className="absolute inset-y-3 -right-1 z-10 w-2 cursor-col-resize rounded-full transition-colors hover:bg-primary/25 focus-visible:bg-primary/40 focus-visible:outline-none"
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
            onDoubleClick={resetSidebarWidth}
            onKeyDown={handleResizeKeyDown}
          />
        )}
      </div>
    );
  }

  // The scrim closes on click rather than touchstart so that a swipe starting
  // on it can drag the drawer shut instead of dismissing it instantly.
  return (
    <div
      className="workspace-drawer fixed inset-0 z-[60] flex"
      data-open={sidebarOpen}
      aria-hidden={!sidebarOpen}
    >
      <button
        type="button"
        tabIndex={-1}
        className="workspace-drawer-scrim fixed inset-0 bg-[hsl(var(--scrim))]"
        onClick={handleBackdropClick}
        aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
      />
      <div
        ref={drawerPanelRef}
        className="workspace-drawer-panel squircle relative h-full w-[86vw] max-w-[340px] overflow-hidden rounded-r-4xl bg-chrome shadow-floating"
        onClick={(event) => event.stopPropagation()}
      >
        <Sidebar {...sidebarSharedProps} />
      </div>
    </div>
  );
}

export default memo(ProjectSidebarRegion);
