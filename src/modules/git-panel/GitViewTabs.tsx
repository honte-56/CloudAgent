import { FileText, GitBranch, GitCompare, GitFork, History } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { GitPanelView } from '@/shared/types';
import { Pill, PillBar } from '@/shared/ui';

type GitViewTabsProps = {
  activeView: GitPanelView;
  isHidden: boolean;
  changeCount: number;
  onChange: (view: GitPanelView) => void;
};

const TABS: { id: GitPanelView; labelKey: string; Icon: typeof FileText }[] = [
  { id: 'changes', labelKey: 'git:tabs.changes', Icon: FileText },
  { id: 'compare', labelKey: 'git:tabs.compare', Icon: GitCompare },
  { id: 'history', labelKey: 'git:tabs.history', Icon: History },
  { id: 'branches', labelKey: 'git:tabs.branches', Icon: GitBranch },
  { id: 'worktrees', labelKey: 'git:tabs.worktrees', Icon: GitFork },
];

/** Rendered by GitPanel to switch between its changes, compare, commits, branches and worktrees views. */
export default function GitViewTabs({ activeView, isHidden, changeCount, onChange }: GitViewTabsProps) {
  const { t } = useTranslation();
  return (
    <div
      className={`transition-all duration-300 ease-in-out ${
        isHidden ? 'max-h-0 -translate-y-2 overflow-hidden opacity-0' : 'max-h-16 translate-y-0 opacity-100'
      }`}
    >
      <div className="scrollbar-hide overflow-x-auto overscroll-x-contain px-3 py-2 [-webkit-overflow-scrolling:touch]">
        <PillBar role="tablist" aria-label={t('git:tabs.ariaLabel')} className="flex min-w-max sm:min-w-0">
          {TABS.map(({ id, labelKey, Icon }) => (
            <Pill
              key={id}
              role="tab"
              aria-selected={activeView === id}
              isActive={activeView === id}
              onClick={() => onChange(id)}
              className="h-8 flex-none justify-center py-0 sm:flex-1"
            >
              <Icon className="h-4 w-4" />
              <span>{t(labelKey)}</span>
              {id === 'changes' && changeCount > 0 && (
                <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-primary">
                  {changeCount}
                </span>
              )}
            </Pill>
          ))}
        </PillBar>
      </div>
    </div>
  );
}
