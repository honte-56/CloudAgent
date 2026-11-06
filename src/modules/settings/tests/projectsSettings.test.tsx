import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@/modules/i18n';
import ProjectsSettingsTab from '@/modules/settings/tabs/ProjectsSettingsTab';
import { resetUserPreferences, readUserPreference } from '@/shared/userSettings';

beforeEach(() => {
  resetUserPreferences();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }))));
});
afterEach(() => { cleanup(); resetUserPreferences(); vi.unstubAllGlobals(); });

test('saves the account default directory in global settings and retains it on reopening', async () => {
  const view = render(<ProjectsSettingsTab />);
  fireEvent.change(screen.getByLabelText('Default directory for new projects'), { target: { value: '/workspace/saved' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save default directory' }));
  await screen.findByText('Saved');
  expect(readUserPreference('defaultProjectDirectory', '')).toBe('/workspace/saved');
  view.unmount();
  render(<ProjectsSettingsTab />);
  expect((screen.getByLabelText('Default directory for new projects') as HTMLInputElement).value).toBe('/workspace/saved');
});
