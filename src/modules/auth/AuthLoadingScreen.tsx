import { useTranslation } from 'react-i18next';

import { CLOUDCLI_WORDMARK_FONT_FAMILY } from '@/shared/constants';

const loadingDotAnimationDelays = ['0s', '0.15s', '0.3s'];

/** Rendered by the auth module's ProtectedRoute while the initial auth status check is in flight. */
export default function AuthLoadingScreen() {
  const { t } = useTranslation('auth');
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-chrome p-4">

      <div className="relative text-center" role="status" aria-live="polite">
        <div className="mb-5 flex justify-center">
          <div className="squircle flex h-16 w-16 items-center justify-center rounded-3xl bg-primary animate-pop-in">
            <img src="/logo.svg" alt="CloudAgent" className="h-9 w-9" />
          </div>
        </div>

        <h1
          className="mb-4 text-2xl font-bold tracking-tight text-foreground"
          style={{ fontFamily: CLOUDCLI_WORDMARK_FONT_FAMILY }}
        >
          CloudAgent
        </h1>
        <p className="sr-only">{t('misc.loadingState')}</p>
        <div aria-hidden className="flex items-center justify-center gap-2">
          {loadingDotAnimationDelays.map((delay) => (
            <div
              key={delay}
              className="h-2 w-2 animate-bounce rounded-full bg-primary"
              style={{ animationDelay: delay }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
