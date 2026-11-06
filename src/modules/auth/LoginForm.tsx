import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Lock, User } from 'lucide-react';

import { useAuth } from '@/modules/auth/context/AuthContext';
import AuthErrorAlert from '@/modules/auth/AuthErrorAlert';
import AuthInputField from '@/modules/auth/AuthInputField';
import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';

type LoginFormState = {
  username: string;
  password: string;
};

const initialState: LoginFormState = {
  username: '',
  password: '',
};

/**
 * Login form component.
 * Rendered by the auth module's ProtectedRoute when no user session exists.
 * Handles credential input with browser autofill support (`autocomplete`
 * attributes) so that password managers can offer to fill saved credentials.
 */
export default function LoginForm() {
  const { t } = useTranslation('auth');
  const { error: sessionError, login } = useAuth();

  const [formState, setFormState] = useState<LoginFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateField = useCallback((field: keyof LoginFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      // Keep form validation local so each auth screen owns its own UI feedback.
      if (!formState.username.trim() || !formState.password) {
        setErrorMessage(t('login.errors.requiredFields'));
        return;
      }

      setIsSubmitting(true);
      const result = await login(formState.username.trim(), formState.password);
      if (!result.success) {
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [formState.password, formState.username, login, t],
  );

  return (
    <AuthScreenLayout
      title={t('login.title')}
      description={t('login.description')}
      footerText={t('login.footerText')}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthInputField
          id="username"
          label={t('login.username')}
          value={formState.username}
          onChange={(value) => updateField('username', value)}
          placeholder={t('login.placeholders.username')}
          isDisabled={isSubmitting}
          autoComplete="username"
          icon={User}
        />

        <AuthInputField
          id="password"
          label={t('login.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('login.placeholders.password')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="current-password"
          icon={Lock}
        />

        <AuthErrorAlert errorMessage={errorMessage || sessionError || ''} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="press flex h-12 w-full items-center justify-center gap-2 rounded-full bg-primary px-5 font-medium text-primary-foreground hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('login.loading')}
            </>
          ) : (
            t('login.submit')
          )}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
