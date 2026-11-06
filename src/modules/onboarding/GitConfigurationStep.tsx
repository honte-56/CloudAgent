import { GitBranch, Mail, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type GitConfigurationStepProps = {
  gitName: string;
  gitEmail: string;
  isSubmitting: boolean;
  onGitNameChange: (value: string) => void;
  onGitEmailChange: (value: string) => void;
};

/** Rendered by Onboarding as its first step, collecting the git identity used for commits. */
export default function GitConfigurationStep({
  gitName,
  gitEmail,
  isSubmitting,
  onGitNameChange,
  onGitEmailChange,
}: GitConfigurationStepProps) {
  const { t } = useTranslation('auth');
  return (
    <div className="space-y-5">
      <div className="text-center">
        <div className="squircle mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-container text-primary-container-foreground">
          <GitBranch className="h-7 w-7 text-primary" />
        </div>
        <h2 className="font-serif text-xl font-bold tracking-tight text-foreground">{t('onboarding.gitStepTitle')}</h2>
        <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
          {t('onboarding.gitStepDescription')}
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label htmlFor="gitName" className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
            <User className="h-4 w-4" />
            {t('onboarding.gitNameLabel')} <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            id="gitName"
            value={gitName}
            onChange={(event) => onGitNameChange(event.target.value)}
            className="squircle w-full rounded-2xl border border-transparent bg-input/70 px-4 py-3 text-foreground transition-[background-color,box-shadow,border-color] placeholder:text-muted-foreground/70 hover:bg-input focus:border-ring/40 focus:bg-card focus:outline-none focus:ring-2 focus:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-60"
            placeholder={t('onboarding.gitNamePlaceholder')}
            required
            disabled={isSubmitting}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('onboarding.gitNameHint')}</p>
        </div>

        <div>
          <label htmlFor="gitEmail" className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
            <Mail className="h-4 w-4" />
            {t('onboarding.gitEmailLabel')} <span className="text-red-500">*</span>
          </label>
          <input
            type="email"
            id="gitEmail"
            value={gitEmail}
            onChange={(event) => onGitEmailChange(event.target.value)}
            className="squircle w-full rounded-2xl border border-transparent bg-input/70 px-4 py-3 text-foreground transition-[background-color,box-shadow,border-color] placeholder:text-muted-foreground/70 hover:bg-input focus:border-ring/40 focus:bg-card focus:outline-none focus:ring-2 focus:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-60"
            placeholder={t('onboarding.gitEmailPlaceholder')}
            required
            disabled={isSubmitting}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('onboarding.gitEmailHint')}</p>
        </div>
      </div>
    </div>
  );
}
