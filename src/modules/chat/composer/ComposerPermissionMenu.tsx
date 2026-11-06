import { memo, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Bot,
  ClipboardList,
  Hand,
  ShieldQuestion,
  Smile,
  type LucideIcon,
} from 'lucide-react';

import type { PermissionMode } from '@/shared/types';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import { usePermissionNameFit } from '@/modules/chat/hooks/usePermissionNameFit';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSurface,
} from '@/modules/chat/composer/ComposerMenuPrimitives';

type ModeAppearance = {
  icon: LucideIcon;
  /** English name, the fallback for the `codex.modes.<mode>` translation. */
  label: string;
  trigger: string;
  item: string;
};

/**
 * Presentation only. Which modes exist for a provider comes from the backend
 * capability matrix, so an unknown mode still renders through UNKNOWN_MODE.
 */
const MODE_APPEARANCE: Record<PermissionMode, ModeAppearance> = {
  default: {
    icon: Hand,
    label: 'Default Mode',
    trigger: 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
    item: 'text-foreground',
  },
  auto: {
    icon: Bot,
    label: 'Auto Mode',
    trigger:
      'bg-blue-500/12 text-blue-700 hover:bg-blue-500/18 dark:text-blue-300',
    item: 'text-blue-700 dark:text-blue-300',
  },
  acceptEdits: {
    icon: Smile,
    label: 'Accept Edits',
    trigger:
      'bg-emerald-500/12 text-emerald-700 hover:bg-emerald-500/18 dark:text-emerald-300',
    item: 'text-green-700 dark:text-green-300',
  },
  bypassPermissions: {
    icon: AlertTriangle,
    label: 'Bypass Permissions',
    trigger:
      'bg-orange-500/12 text-orange-700 hover:bg-orange-500/18 dark:text-orange-300',
    item: 'text-orange-600 dark:text-orange-400',
  },
  plan: {
    icon: ClipboardList,
    label: 'Plan Mode',
    trigger: 'bg-primary-container text-primary-container-foreground hover:brightness-[0.97] dark:hover:brightness-110',
    item: 'text-primary',
  },
};

const UNKNOWN_MODE: ModeAppearance = {
  icon: ShieldQuestion,
  label: '',
  trigger: 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
  item: 'text-foreground',
};

const getAppearance = (mode: PermissionMode | string): ModeAppearance =>
  MODE_APPEARANCE[mode as PermissionMode] ?? UNKNOWN_MODE;

type ComposerPermissionMenuProps = {
  permissionMode: PermissionMode;
  /** Modes the active provider supports, in the order the backend reports them. */
  permissionModes: PermissionMode[];
  onSelectPermissionMode: (mode: PermissionMode) => void;
  providerLabel: string;
};

/**
 * Rendered by chat's ChatComposer as the popover for choosing the permission
 * mode the active provider runs the next turn under.
 */
function ComposerPermissionMenu({
  permissionMode,
  permissionModes,
  onSelectPermissionMode,
  providerLabel,
}: ComposerPermissionMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, 22 * 16);
  const modeLabel = (mode: PermissionMode) =>
    t(`codex.modes.${mode}`, { defaultValue: getAppearance(mode).label || mode });
  const activeModeLabel = modeLabel(permissionMode);
  // The name is shown only where the composer has room for it, so it never
  // pushes the model menu and the send button onto a second row. Plan mode,
  // the one that changes nothing, keeps its name wherever it fits inside the
  // composer, even when that gives the controls a row of their own.
  const isNameShown = usePermissionNameFit(
    triggerRef,
    permissionModes.length > 0 ? activeModeLabel : null,
    permissionMode === 'plan',
  );

  if (permissionModes.length === 0) {
    return null;
  }

  const activeAppearance = getAppearance(permissionMode);
  const ActiveIcon = activeAppearance.icon;
  const heading = t('composer.permissionHeading', {
    provider: providerLabel,
    defaultValue: 'How should {{provider}} actions be approved?',
  });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className={`press flex h-8 min-w-8 max-w-40 shrink-0 items-center justify-center gap-1.5 rounded-full text-xs font-medium sm:h-9 sm:min-w-9 sm:max-w-48 ${isNameShown ? 'px-3' : 'w-8 sm:w-9'} ${activeAppearance.trigger}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        // The mode name leads the accessible name, so what a screen reader
        // announces starts with what the button shows.
        aria-label={t('composer.permissionTriggerLabel', {
          mode: activeModeLabel,
          heading,
          defaultValue: '{{mode}}: {{heading}}',
        })}
        title={t('input.clickToChangeMode')}
      >
        <ActiveIcon className="h-4 w-4 shrink-0" />
        {/* Named, not just drawn: the mode decides what the next message may change. */}
        {isNameShown && <span className="truncate">{activeModeLabel}</span>}
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={heading}>
          <ComposerMenuHeading>{heading}</ComposerMenuHeading>
          {permissionModes.map((mode) => {
            const appearance = getAppearance(mode);
            const ModeIcon = appearance.icon;
            return (
              <ComposerMenuItem
                key={mode}
                icon={<ModeIcon className="h-4 w-4" />}
                label={modeLabel(mode)}
                description={t(`codex.descriptions.${mode}`, { defaultValue: '' }) || undefined}
                isSelected={mode === permissionMode}
                onSelect={() => {
                  onSelectPermissionMode(mode);
                  setIsOpen(false);
                }}
                className={appearance.item}
              />
            );
          })}
          <ComposerMenuHeading>
            {t('composer.permissionCycleHint', { defaultValue: 'Press Tab in the message box to switch modes' })}
          </ComposerMenuHeading>
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}

/** Memoized: the composer re-renders on every keystroke and none of this menu's props change while typing. */
export default memo(ComposerPermissionMenu);
