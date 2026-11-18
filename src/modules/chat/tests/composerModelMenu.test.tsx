import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key }),
}));

test('an unavailable catalog keeps the menu accessible with automatic read, error and manual retry', async () => {
  const onRefresh = vi.fn(async () => {});
  render(<ComposerModelMenu model="" modelOptions={[]} effort="default" effortOptions={[]}
    onSelectEffort={() => {}} onSelectModel={() => {}} modelsLoading={false}
    discovery={{ status: 'unavailable' }} onRefresh={onRefresh} />);
  fireEvent.click(screen.getByRole('button', { name: 'Select model and reasoning effort' }));
  expect(onRefresh).toHaveBeenCalledWith();
  await waitFor(() => expect(screen.getByText(/Unable to read models/)).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
  expect(onRefresh).toHaveBeenLastCalledWith(true);
});
