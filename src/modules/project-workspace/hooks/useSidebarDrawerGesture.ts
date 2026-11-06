import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

// A touch must begin this close to the left edge to pull a closed drawer out,
// so ordinary horizontal gestures in the content (code blocks, tables) stay theirs.
const EDGE_ZONE_PX = 24;
// Movement before the gesture commits to a direction.
const DRAG_SLOP_PX = 10;
// A release faster than this settles in the direction of travel regardless of
// how far the drawer had moved; slower releases settle to the nearer side.
const FLING_VELOCITY_PX_PER_MS = 0.35;
// Only the last stretch of a drag says how fast it was released.
const VELOCITY_WINDOW_MS = 90;
// The smooth spring settles in 370ms; the receding main layer keeps its
// transform until then so the close animation can play out.
const SETTLE_MS = 420;
const FALLBACK_DRAWER_WIDTH_PX = 320;

type SidebarDrawerGestureOptions = {
  /** Only the mobile drawer is draggable; the docked desktop sidebar is not. */
  enabled: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  /**
   * Receives the `--drawer-progress` variable (0 closed … 1 open) and the
   * `data-drawer-*` attributes that the drawer, scrim and main layer style from.
   */
  rootRef: RefObject<HTMLElement | null>;
  /** The sliding panel, measured for the drag distance. */
  panelRef: RefObject<HTMLElement | null>;
};

type DragSample = { x: number; time: number };

type DrawerDrag = {
  startX: number;
  startY: number;
  startProgress: number;
  width: number;
  dragging: boolean;
  samples: DragSample[];
};

type TimerRef = { current: number | null };

// Moves the drawer to a resting side. The main layer only carries a transform
// while the drawer is out (or on its way in), because a lingering transform
// would become the containing block of every fixed-position descendant.
function settleDrawer(root: HTMLElement, toOpen: boolean, settleTimerRef: TimerRef) {
  if (settleTimerRef.current !== null) {
    window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
  }
  root.dataset.drawerActive = 'true';
  root.style.setProperty('--drawer-progress', toOpen ? '1' : '0');
  if (!toOpen) {
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      delete root.dataset.drawerActive;
    }, SETTLE_MS);
  }
}

/**
 * Drives the mobile sidebar drawer like a physical sheet: an edge swipe pulls it
 * out, a swipe on the open drawer or its scrim pushes it back, and the drawer
 * follows the finger 1:1 before springing to whichever side the release favours.
 */
export function useSidebarDrawerGesture({
  enabled,
  open,
  setOpen,
  rootRef,
  panelRef,
}: SidebarDrawerGestureOptions) {
  // Read by the native listeners, which are bound once per enable and would
  // otherwise see the open state from when they were attached.
  const openRef = useRef(open);
  const settleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (!enabled) {
      root.style.removeProperty('--drawer-progress');
      delete root.dataset.drawerActive;
      delete root.dataset.drawerDragging;
      return;
    }
    settleDrawer(root, open, settleTimerRef);
  }, [enabled, open, rootRef]);

  useEffect(() => () => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return;

    let drag: DrawerDrag | null = null;

    const endDrag = () => {
      const finished = drag;
      drag = null;
      if (!finished?.dragging) return;
      delete root.dataset.drawerDragging;

      const progress = Number.parseFloat(root.style.getPropertyValue('--drawer-progress')) || 0;
      const first = finished.samples[0];
      const last = finished.samples[finished.samples.length - 1];
      const elapsed = first && last ? last.time - first.time : 0;
      const velocity = elapsed > 0 ? (last.x - first.x) / elapsed : 0;
      const shouldOpen = Math.abs(velocity) > FLING_VELOCITY_PX_PER_MS ? velocity > 0 : progress > 0.5;

      if (shouldOpen === openRef.current) {
        // The state is unchanged, so no effect will run; spring back by hand.
        settleDrawer(root, shouldOpen, settleTimerRef);
      } else {
        setOpen(shouldOpen);
      }
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        drag = null;
        return;
      }
      const touch = event.touches[0];
      const isOpen = openRef.current;
      const drawerLayer = panelRef.current?.parentElement;
      if (!isOpen && touch.clientX > EDGE_ZONE_PX) return;
      if (isOpen && !(drawerLayer && event.target instanceof Node && drawerLayer.contains(event.target))) return;

      drag = {
        startX: touch.clientX,
        startY: touch.clientY,
        startProgress: isOpen ? 1 : 0,
        width: panelRef.current?.getBoundingClientRect().width || FALLBACK_DRAWER_WIDTH_PX,
        dragging: false,
        samples: [{ x: touch.clientX, time: event.timeStamp }],
      };
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!drag) return;
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - drag.startX;
      const dy = touch.clientY - drag.startY;

      if (!drag.dragging) {
        if (Math.abs(dx) < DRAG_SLOP_PX && Math.abs(dy) < DRAG_SLOP_PX) return;
        const isHorizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
        const movesTowardOtherSide = drag.startProgress === 1 ? dx < 0 : dx > 0;
        // Vertical intent, or a push against the side the drawer is already
        // on, leaves the touch to scrolling and the content underneath.
        if (!isHorizontal || !movesTowardOtherSide) {
          drag = null;
          return;
        }
        drag.dragging = true;
        if (settleTimerRef.current !== null) {
          window.clearTimeout(settleTimerRef.current);
          settleTimerRef.current = null;
        }
        root.dataset.drawerActive = 'true';
        root.dataset.drawerDragging = 'true';
      }

      // Once the drawer owns the gesture the list under the finger must not
      // scroll along with it.
      if (event.cancelable) event.preventDefault();
      const progress = Math.min(1, Math.max(0, drag.startProgress + dx / drag.width));
      root.style.setProperty('--drawer-progress', progress.toFixed(4));

      drag.samples.push({ x: touch.clientX, time: event.timeStamp });
      while (drag.samples.length > 2 && event.timeStamp - drag.samples[0].time > VELOCITY_WINDOW_MS) {
        drag.samples.shift();
      }
    };

    root.addEventListener('touchstart', handleTouchStart, { passive: true });
    root.addEventListener('touchmove', handleTouchMove, { passive: false });
    root.addEventListener('touchend', endDrag);
    root.addEventListener('touchcancel', endDrag);
    return () => {
      root.removeEventListener('touchstart', handleTouchStart);
      root.removeEventListener('touchmove', handleTouchMove);
      root.removeEventListener('touchend', endDrag);
      root.removeEventListener('touchcancel', endDrag);
      delete root.dataset.drawerDragging;
    };
  }, [enabled, panelRef, rootRef, setOpen]);
}
