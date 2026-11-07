import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

const DRAG_SLOP_PX = 10;
const FLING_VELOCITY_PX_PER_MS = 0.35;
const VELOCITY_WINDOW_MS = 90;
// Allows the 370ms spring to finish before releasing the main layer's transform.
const SETTLE_MS = 420;
const FALLBACK_DRAWER_WIDTH_PX = 320;

type SidebarDrawerGestureOptions = {
  enabled: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Workspace boundary for touch events; motion styles never go on this ancestor. */
  rootRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
};

type DragSample = { x: number; time: number };
type DrawerDrag = {
  startX: number;
  startY: number;
  startProgress: number;
  progress: number;
  width: number;
  dragging: boolean;
  samples: DragSample[];
};

// Editors, controls, overlays and horizontally scrollable content keep their touches.
function canStartOpeningDrawer(target: EventTarget | null, root: HTMLElement) {
  if (!(target instanceof Element)) return false;
  const mainLayer = target.closest('.workspace-main-layer');
  if (!mainLayer || !root.contains(mainLayer)) return false;
  if (target.closest('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"], [role="slider"], .xterm, .cm-editor')) return false;
  if (window.getSelection()?.isCollapsed === false) return false;

  for (let element: Element | null = target; element && element !== root; element = element.parentElement) {
    if (element.scrollWidth <= element.clientWidth) continue;
    const overflowX = window.getComputedStyle(element).overflowX;
    if (overflowX === 'auto' || overflowX === 'scroll') return false;
  }
  return true;
}

// Read the actual compositor position when catching a spring mid-flight, rather
// than restarting from React's fully-open/closed destination. This read is once
// at touchstart; touchmove never reads layout or computed styles.
function readProgress(panel: HTMLElement, width: number, fallback: number) {
  const transform = window.getComputedStyle(panel).transform;
  const match = transform.match(/^matrix(3d)?\((.+)\)$/);
  if (!match) return fallback;
  const values = match[2].split(',').map(Number);
  const x = values[match[1] ? 12 : 4];
  return Number.isFinite(x) ? Math.min(1, Math.max(0, 1 + x / width)) : fallback;
}

/** Used by ProjectSidebarRegion for frame-paced drag motion and immediate release into its CSS spring. */
export function useSidebarDrawerGesture({ enabled, open, setOpen, rootRef, panelRef }: SidebarDrawerGestureOptions) {
  // Native listeners keep the latest committed state without reattaching mid-drag.
  const openRef = useRef(open);
  const setOpenRef = useRef(setOpen);
  // Owns the imperative animation for this mounted mobile panel, independently of React commits.
  const motionRef = useRef<{ syncOpen(value: boolean): void } | null>(null);

  useLayoutEffect(() => {
    openRef.current = open;
    setOpenRef.current = setOpen;
  }, [open, setOpen]);

  // The workspace ref belongs to a parent host element. Its ref is attached
  // after this child's layout effects, so bind only after the entire commit.
  useEffect(() => {
    const root = rootRef.current;
    const panel = panelRef.current;
    const layer = panel?.parentElement;
    if (!enabled || !root || !panel || !layer) return;
    const scrim = layer.querySelector<HTMLElement>('.workspace-drawer-scrim');
    const main = root.querySelector<HTMLElement>(':scope > .workspace-main-layer');
    let targetOpen = openRef.current;
    let paintedProgress = targetOpen ? 1 : 0;
    let drag: DrawerDrag | null = null;
    let frame: number | null = null;
    let settleTimer: number | null = null;

    const cancelFrame = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
    };
    const clearSettleTimer = () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = null;
    };
    const paint = (progress: number) => {
      paintedProgress = progress;
      // An inherited custom property on the workspace used to invalidate styles
      // throughout the transcript on every touchmove. Touch only these three layers.
      panel.style.transform = `translate3d(${(progress - 1) * 100}%, 0, 0)`;
      if (scrim) scrim.style.opacity = String(progress);
      if (main) main.style.transform = `translate3d(${progress * 56}px, 0, 0)`;
    };
    const markDragging = (value: boolean) => {
      if (value) {
        layer.dataset.drawerDragging = 'true';
        if (main) main.dataset.drawerDragging = 'true';
      } else {
        delete layer.dataset.drawerDragging;
        if (main) delete main.dataset.drawerDragging;
      }
    };
    const releaseMain = () => {
      main?.style.removeProperty('transform');
      if (main) delete main.dataset.drawerActive;
    };
    const settle = (toOpen: boolean) => {
      cancelFrame();
      clearSettleTimer();
      drag = null;
      targetOpen = toOpen;
      layer.dataset.drawerVisible = 'true';
      if (main) main.dataset.drawerActive = 'true';
      markDragging(false);
      // Start the transition now, before setOpen triggers any React work.
      // Unpainted moves are discarded so the spring starts at the last visible frame.
      paint(toOpen ? 1 : 0);
      if (!toOpen) {
        settleTimer = window.setTimeout(() => {
          settleTimer = null;
          delete layer.dataset.drawerVisible;
          releaseMain();
        }, SETTLE_MS);
      }
    };

    paint(paintedProgress);
    if (targetOpen) {
      layer.dataset.drawerVisible = 'true';
      if (main) main.dataset.drawerActive = 'true';
    } else {
      releaseMain();
    }
    motionRef.current = {
      syncOpen(value) {
        if (targetOpen !== value) settle(value);
      },
    };

    const cancelDrag = () => {
      const wasDragging = drag?.dragging;
      drag = null;
      if (wasDragging) settle(openRef.current);
    };
    const endDrag = (event: TouchEvent) => {
      const finished = drag;
      drag = null;
      if (!finished?.dragging) return;
      const first = finished.samples[0];
      const last = finished.samples[finished.samples.length - 1];
      const elapsed = last.time - first.time;
      const velocity = elapsed > 0 && event.timeStamp - last.time <= VELOCITY_WINDOW_MS
        ? (last.x - first.x) / elapsed : 0;
      const shouldOpen = Math.abs(velocity) > FLING_VELOCITY_PX_PER_MS ? velocity > 0 : finished.progress > 0.5;
      settle(shouldOpen);
      if (shouldOpen !== openRef.current) setOpenRef.current(shouldOpen);
    };
    const handleTouchStart = (event: TouchEvent) => {
      cancelDrag();
      if (event.touches.length !== 1) return;
      const inDrawer = event.target instanceof Node && layer.contains(event.target);
      if (openRef.current && !inDrawer) return;
      if (!openRef.current && !(inDrawer && layer.dataset.drawerVisible) && !canStartOpeningDrawer(event.target, root)) return;
      const touch = event.touches[0];
      const width = panel.getBoundingClientRect().width || FALLBACK_DRAWER_WIDTH_PX;
      const progress = readProgress(panel, width, paintedProgress);
      drag = {
        startX: touch.clientX, startY: touch.clientY, startProgress: progress,
        progress, width, dragging: false,
        samples: [{ x: touch.clientX, time: event.timeStamp }],
      };
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (!drag) return;
      if (event.touches.length !== 1) { cancelDrag(); return; }
      const touch = event.touches[0];
      const dx = touch.clientX - drag.startX;
      const dy = touch.clientY - drag.startY;
      if (!drag.dragging) {
        if (Math.abs(dx) < DRAG_SLOP_PX && Math.abs(dy) < DRAG_SLOP_PX) return;
        const isHorizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
        const movesTowardOtherSide = drag.startProgress <= 0 ? dx > 0 : drag.startProgress >= 1 ? dx < 0 : true;
        if (!isHorizontal || !movesTowardOtherSide) { drag = null; return; }
        drag.dragging = true;
        clearSettleTimer();
        layer.dataset.drawerVisible = 'true';
        if (main) main.dataset.drawerActive = 'true';
        markDragging(true);
      }
      if (event.cancelable) event.preventDefault();
      drag.progress = Math.min(1, Math.max(0, drag.startProgress + dx / drag.width));
      drag.samples.push({ x: touch.clientX, time: event.timeStamp });
      while (drag.samples.length > 2 && event.timeStamp - drag.samples[0].time > VELOCITY_WINDOW_MS) drag.samples.shift();
      // Touch delivery can exceed the display refresh rate. Paint only the newest
      // position once per frame, with no React renders in the move path.
      if (frame === null) frame = window.requestAnimationFrame(() => {
        frame = null;
        if (drag?.dragging) paint(drag.progress);
      });
    };

    root.addEventListener('touchstart', handleTouchStart, { passive: true });
    root.addEventListener('touchmove', handleTouchMove, { passive: false });
    root.addEventListener('touchend', endDrag);
    root.addEventListener('touchcancel', cancelDrag);
    return () => {
      cancelFrame();
      clearSettleTimer();
      motionRef.current = null;
      root.removeEventListener('touchstart', handleTouchStart);
      root.removeEventListener('touchmove', handleTouchMove);
      root.removeEventListener('touchend', endDrag);
      root.removeEventListener('touchcancel', cancelDrag);
      markDragging(false);
      delete layer.dataset.drawerVisible;
      panel.style.removeProperty('transform');
      scrim?.style.removeProperty('opacity');
      releaseMain();
    };
  }, [enabled, panelRef, rootRef]);

  useLayoutEffect(() => {
    motionRef.current?.syncOpen(open);
  }, [open]);
}
