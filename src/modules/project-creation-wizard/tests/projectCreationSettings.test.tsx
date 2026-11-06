import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@/modules/i18n';
import ProjectCreationWizard from '@/modules/project-creation-wizard/ProjectCreationWizard';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

let created: Record<string, unknown> | undefined;
beforeEach(() => {
  resetUserPreferences(); created = undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('create-project')) { created = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ success: true, project: { projectId: 'new-project' } })); }
    if (url.includes('credentials')) return new Response(JSON.stringify({ credentials: [{ id: 7, credential_name: 'My GitHub', is_active: true }] }));
    return new Response(JSON.stringify({ suggestions: [], path: '/', success: true }));
  }));
});
afterEach(() => { cleanup(); resetUserPreferences(); vi.unstubAllGlobals(); });

test('creates an empty project under the default directory with a stored GitHub credential and shows it in review', async () => {
  writeUserPreference('defaultProjectDirectory', '/workspace/projects');
  const onCreated = vi.fn();
  render(<ProjectCreationWizard onClose={() => {}} onProjectCreated={onCreated} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Stored Token' }));
  fireEvent.change(screen.getByPlaceholderText('/path/to/project/workspace'), { target: { value: 'my-project' } });
  fireEvent.click(screen.getByRole('button', { name: /Next/ }));
  expect(screen.getByText('/workspace/projects/my-project')).toBeTruthy();
  expect(screen.getByText(/My GitHub/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  expect(created).toEqual({ path: '/workspace/projects/my-project', githubTokenId: 7, newGithubToken: null });
});

test('allows a full path outside the default directory without implicitly binding any credential', async () => {
  writeUserPreference('defaultProjectDirectory', '/workspace/projects');
  render(<ProjectCreationWizard onClose={() => {}} />);
  await screen.findByRole('button', { name: 'Stored Token' });
  fireEvent.change(screen.getByPlaceholderText('/path/to/project/workspace'), { target: { value: '/another/project' } });
  fireEvent.click(screen.getByRole('button', { name: /Next/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));
  await waitFor(() => expect(created).toEqual({ path: '/another/project', githubTokenId: null, newGithubToken: null }));
});

