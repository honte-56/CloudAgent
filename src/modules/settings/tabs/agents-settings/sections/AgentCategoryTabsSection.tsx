import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import type { AgentCategory, AgentProvider } from '@/shared/types';

type AgentCategoryTabsSectionProps = {
  categories: AgentCategory[];
  selectedAgent: AgentProvider;
  selectedCategory: AgentCategory;
  onSelectCategory: (category: AgentCategory) => void;
};

/** Rendered by AgentsSettingsTab to switch between the selected provider's categories. */
export default function AgentCategoryTabsSection({
  categories,
  selectedAgent,
  selectedCategory,
  onSelectCategory,
}: AgentCategoryTabsSectionProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="flex-shrink-0">
      <div role="tablist" className="scrollbar-hide flex overflow-x-auto px-2 md:px-4">
        {categories.map((category) => (
          <button
            key={category}
            role="tab"
            aria-selected={selectedCategory === category}
            onClick={() => onSelectCategory(category)}
            className={cn(
              // Second-level tabs: plain labels with a short rounded indicator,
              // so they read as subordinate to the segmented provider picker above.
              'relative whitespace-nowrap px-4 py-3 text-sm font-medium touch-manipulation transition-colors duration-150',
              'after:absolute after:inset-x-4 after:bottom-0.5 after:h-[3px] after:rounded-full after:transition-transform after:duration-spring-snappy after:ease-spring-snappy',
              selectedCategory === category
                ? 'text-foreground after:scale-x-100 after:bg-primary'
                : 'text-muted-foreground after:scale-x-0 after:bg-primary hover:text-foreground',
            )}
          >
            {category === 'account' && t('tabs.account')}
            {category === 'permissions' && t('tabs.permissions')}
            {category === 'mcp' && t('tabs.mcpServers')}
            {category === 'skills' && t('tabs.skills', {
              defaultValue: selectedAgent === 'opencode' ? 'Shared Skills' : 'Skills',
            })}
          </button>
        ))}
      </div>
    </div>
  );
}
