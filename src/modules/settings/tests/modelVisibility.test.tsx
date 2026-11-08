import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import ModelsContent from '@/modules/settings/tabs/agents-settings/sections/content/ModelsContent';
import { readUserPreference, resetUserPreferences } from '@/shared/userSettings';
import type { LLMProvider } from '@/shared/types';

const mocks = vi.hoisted(() => ({ save: vi.fn(), models: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { user: { savePreferences: mocks.save }, providers: { models: mocks.models } } }));

beforeEach(async () => {
  localStorage.clear();
  resetUserPreferences();
  await i18n.changeLanguage('en');
  mocks.save.mockReset().mockResolvedValue({ ok: true });
  mocks.models.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: { models: {
      DEFAULT: 'provider/model-0',
      OPTIONS: Array.from({ length: 120 }, (_, index) => ({ value: `provider/model-${index}`, label: `Model ${index}` })),
    } } }),
  });
});

test.each<LLMProvider>(['claude', 'codex', 'opencode', 'cursor'])('searches a large catalog and saves only checked models for %s', async (provider) => {
  render(<ModelsContent provider={provider} />);
  await screen.findByText('120 of 120 selected');
  fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
  expect(screen.getByRole('button', { name: 'Save models' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'provider/model-117' } });
  const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  fireEvent.click(checkbox);
  // Search changes must not discard the selection made on an earlier result page.
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'provider/model-119' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Save models' }));
  await screen.findByText('Saved. Conversation model lists have been updated.');
  expect(mocks.save).toHaveBeenCalledWith({ [`${provider}VisibleModels`]: ['provider/model-117', 'provider/model-119'] });
  expect(readUserPreference(`${provider}VisibleModels`, null)).toEqual(['provider/model-117', 'provider/model-119']);
  expect(JSON.parse(localStorage.getItem('user-preferences')!)[`${provider}VisibleModels`]).toEqual(['provider/model-117', 'provider/model-119']);
});

test('a failed save keeps the draft for retry and does not publish an unconfirmed preference', async () => {
  mocks.save.mockResolvedValueOnce({ ok: false });
  render(<ModelsContent provider="opencode" />);
  await screen.findByText('120 of 120 selected');
  fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
  fireEvent.click(screen.getAllByRole('checkbox')[5]);
  fireEvent.click(screen.getByRole('button', { name: 'Save models' }));
  await screen.findByRole('alert');
  expect(readUserPreference('opencodeVisibleModels', null)).toBe(null);
  expect((screen.getAllByRole('checkbox')[5] as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save models' }));
  await screen.findByText('Saved. Conversation model lists have been updated.');
  expect(readUserPreference('opencodeVisibleModels', null)).toEqual(['provider/model-5']);
});

test('show all removes the restriction and a failed model request can be retried', async () => {
  mocks.models.mockRejectedValueOnce(new Error('offline'));
  render(<ModelsContent provider="codex" />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('120 of 120 selected');
  fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save models' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ codexVisibleModels: null }));
});
