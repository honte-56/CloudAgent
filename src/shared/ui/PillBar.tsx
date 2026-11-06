import { useLayoutEffect, useRef } from 'react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { cn } from '@/shared/utils';

/* ── Container ─────────────────────────────────────────────────── */
type PillBarProps = ComponentPropsWithoutRef<'div'> & {
  children: ReactNode;
};

// Places the sliding thumb under the active pill. `animate` is false for the
// first placement so the thumb appears in place instead of flying in from 0.
function placeThumb(bar: HTMLElement, thumb: HTMLElement, animate: boolean) {
  const active = bar.querySelector<HTMLElement>('[data-pill-active="true"]');
  if (!active) {
    thumb.style.opacity = '0';
    return;
  }
  const barRect = bar.getBoundingClientRect();
  const pillRect = active.getBoundingClientRect();
  // The bar itself may scroll (the settings tab strip does), and the thumb
  // scrolls with its content, so positions are measured in content space.
  const left = pillRect.left - barRect.left + bar.scrollLeft - bar.clientLeft;
  const top = pillRect.top - barRect.top + bar.scrollTop - bar.clientTop;

  if (!animate) thumb.style.transition = 'none';
  thumb.style.opacity = '1';
  thumb.style.width = `${pillRect.width}px`;
  thumb.style.height = `${pillRect.height}px`;
  thumb.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  if (!animate) {
    // Commit the jump before restoring the spring for later moves.
    void thumb.offsetWidth;
    thumb.style.transition = '';
  }
}

/**
 * Used by the project-workspace and settings modules as the segmented tab strip.
 * A single thumb travels between pills on a spring instead of each pill painting
 * its own selected background, so switching tabs reads as one object moving.
 */
export function PillBar({ children, className, ...props }: PillBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const bar = barRef.current;
    const thumb = thumbRef.current;
    if (!bar || !thumb) return;

    placeThumb(bar, thumb, false);

    // Pills report selection through an attribute, so the thumb follows any
    // change in which one is active as well as any change in their sizes
    // (a label appearing on the newly active pill, a font loading late).
    const mutationObserver = new MutationObserver(() => placeThumb(bar, thumb, true));
    mutationObserver.observe(bar, { attributes: true, attributeFilter: ['data-pill-active'], subtree: true, childList: true });
    const resizeObserver = new ResizeObserver(() => placeThumb(bar, thumb, true));
    resizeObserver.observe(bar);
    for (const pill of bar.querySelectorAll('[data-pill-active]')) resizeObserver.observe(pill);

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, []);

  return (
    <div
      ref={barRef}
      className={cn('relative inline-flex items-center gap-0.5 rounded-full bg-muted p-1', className)}
      {...props}
    >
      <span
        ref={thumbRef}
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 rounded-full bg-card opacity-0 shadow-raised transition-[transform,width,height,opacity] duration-spring-snappy ease-spring-snappy dark:bg-accent"
      />
      {children}
    </div>
  );
}

/* ── Individual pill button ────────────────────────────────────── */
type PillProps = Omit<ComponentPropsWithoutRef<'button'>, 'onClick'> & {
  isActive: boolean;
  onClick: () => void;
  children: ReactNode;
};

/** A single tab inside PillBar, used by the project-workspace and settings modules. */
export function Pill({ isActive, onClick, children, className, ...props }: PillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-pill-active={isActive}
      className={cn(
        'press relative z-[1] flex shrink-0 touch-manipulation items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        isActive
          ? 'text-foreground'
          : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
