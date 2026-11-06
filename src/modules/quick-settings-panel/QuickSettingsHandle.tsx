import type {
  MouseEvent as ReactMouseEvent,
  TouchEvent as ReactTouchEvent,
} from 'react';
import {
  ChevronLeft,
  ChevronRight,
  GripVertical,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { QuickSettingsHandleStyle } from '@/shared/types';

type QuickSettingsHandleProps = {
  isOpen: boolean;
  isDragging: boolean;
  style: QuickSettingsHandleStyle;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onTouchStart: (event: ReactTouchEvent<HTMLButtonElement>) => void;
};

/** Rendered by QuickSettingsPanelView as the draggable edge handle that opens and closes the drawer. */
export default function QuickSettingsHandle({
  isOpen,
  isDragging,
  style,
  onClick,
  onMouseDown,
  onTouchStart,
}: QuickSettingsHandleProps) {
  const { t } = useTranslation('settings');

  const placementClass = isOpen ? 'right-64' : 'right-0';
  const borderClass = isDragging ? 'border-primary/60' : 'border-border/60';
  // Follows the panel edge on the same spring the panel slides on; while the
  // handle is being dragged vertically it must track the finger instead.
  const transitionClass = isDragging
    ? ''
    : 'transition-[right,background-color,box-shadow] duration-spring-smooth ease-spring-smooth';
  const cursorClass = isDragging ? 'cursor-grabbing' : 'cursor-pointer';
  const ariaLabel = isDragging
    ? t('quickSettings.dragHandle.dragging')
    : isOpen
      ? t('quickSettings.dragHandle.closePanel')
      : t('quickSettings.dragHandle.openPanel');
  const title = isDragging
    ? t('quickSettings.dragHandle.draggingStatus')
    : t('quickSettings.dragHandle.toggleAndMove');

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
      className={`fixed ${placementClass} z-50 ${transitionClass} border border-r-0 bg-card/90 backdrop-blur-md ${borderClass} rounded-l-2xl px-1 py-3 shadow-floating hover:bg-card ${cursorClass} touch-none`}
      style={{
        ...style,
        touchAction: 'none',
        WebkitTouchCallout: 'none',
        WebkitUserSelect: 'none',
      }}
      aria-label={ariaLabel}
      title={title}
    >
      {isDragging ? (
        <GripVertical className="h-4 w-4 text-primary" />
      ) : isOpen ? (
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      ) : (
        <ChevronLeft className="h-4 w-4 text-muted-foreground" />
      )}
    </button>
  );
}
