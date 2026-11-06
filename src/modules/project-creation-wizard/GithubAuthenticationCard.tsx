import { Key, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Input } from '@/shared/ui';
import type { GithubTokenCredential, TokenMode } from '@/shared/types';

type GithubAuthenticationCardProps = {
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
  availableTokens: GithubTokenCredential[];
  loadingTokens: boolean;
  tokenLoadError: string | null;
  onTokenModeChange: (tokenMode: TokenMode) => void;
  onSelectedGithubTokenChange: (tokenId: string) => void;
  onNewGithubTokenChange: (tokenValue: string) => void;
};

const getModeClassName = (mode: TokenMode, selectedMode: TokenMode) =>
  `px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
    mode === selectedMode
      ? mode === 'none'
        ? 'bg-green-500 text-white'
        : 'bg-primary text-primary-foreground'
      : 'bg-accent text-foreground/80'
  }`;

/** Rendered by StepConfiguration to choose the GitHub credential bound to empty or cloned projects. */
export default function GithubAuthenticationCard({
  tokenMode,
  selectedGithubToken,
  newGithubToken,
  availableTokens,
  loadingTokens,
  tokenLoadError,
  onTokenModeChange,
  onSelectedGithubTokenChange,
  onNewGithubTokenChange,
}: GithubAuthenticationCardProps) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-border bg-muted p-4">
      <div className="mb-4 flex items-start gap-3">
        <Key className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" />
        <div className="flex-1">
          <h5 className="mb-1 font-medium text-foreground">
            {t('projectWizard.step2.githubAuth')}
          </h5>
          <p className="text-sm text-muted-foreground">
            {t('projectWizard.step2.githubAuthHelp')}
          </p>
        </div>
      </div>

      {loadingTokens && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('projectWizard.step2.loadingTokens')}
        </div>
      )}

      {!loadingTokens && tokenLoadError && (
        <p className="mb-3 text-sm text-red-600 dark:text-red-400">{tokenLoadError}</p>
      )}

      {!loadingTokens && availableTokens.length > 0 && (
        <>
          <div className="mb-4 grid grid-cols-3 gap-2">
            <button
              onClick={() => onTokenModeChange('stored')}
              className={getModeClassName(tokenMode, 'stored')}
            >
              {t('projectWizard.step2.storedToken')}
            </button>
            <button
              onClick={() => onTokenModeChange('new')}
              className={getModeClassName(tokenMode, 'new')}
            >
              {t('projectWizard.step2.newToken')}
            </button>
            <button
              onClick={() => {
                onTokenModeChange('none');
                onSelectedGithubTokenChange('');
                onNewGithubTokenChange('');
              }}
              className={getModeClassName(tokenMode, 'none')}
            >
              {t('projectWizard.step2.nonePublic')}
            </button>
          </div>

          {tokenMode === 'stored' ? (
            <div>
              <label className="mb-2 block text-sm font-medium text-foreground/80">
                {t('projectWizard.step2.selectToken')}
              </label>
              <select
                value={selectedGithubToken}
                onChange={(event) => onSelectedGithubTokenChange(event.target.value)}
                className="w-full rounded-xl border border-transparent bg-input/70 px-3 py-2 text-sm focus:bg-card focus:border-ring/40"
              >
                <option value="">{t('projectWizard.step2.selectTokenPlaceholder')}</option>
                {availableTokens.map((token) => (
                  <option key={token.id} value={String(token.id)}>
                    {token.credential_name}
                  </option>
                ))}
              </select>
            </div>
          ) : tokenMode === 'new' ? (
            <div>
              <label className="mb-2 block text-sm font-medium text-foreground/80">
                {t('projectWizard.step2.newToken')}
              </label>
              <Input
                type="password"
                value={newGithubToken}
                onChange={(event) => onNewGithubTokenChange(event.target.value)}
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                className="w-full"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t('projectWizard.step2.tokenHelp')}
              </p>
            </div>
          ) : null}
        </>
      )}

      {!loadingTokens && availableTokens.length === 0 && (
        <div className="space-y-4">
          <div className="rounded-lg border border-primary/30 bg-primary/10 p-3">
            <p className="text-sm text-primary">
              {t('projectWizard.step2.publicRepoInfo')}
            </p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-foreground/80">
              {t('projectWizard.step2.optionalTokenPublic')}
            </label>
            <Input
              type="password"
              value={newGithubToken}
              onChange={(event) => {
                const tokenValue = event.target.value;
                onNewGithubTokenChange(tokenValue);
                onTokenModeChange(tokenValue.trim() ? 'new' : 'none');
              }}
              placeholder={t('projectWizard.step2.tokenPublicPlaceholder')}
              className="w-full"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t('projectWizard.step2.noTokensHelp')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
