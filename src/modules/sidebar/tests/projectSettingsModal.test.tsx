import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@/modules/i18n';
import ProjectSettingsModal from '@/modules/sidebar/ProjectSettingsModal';

const project = { projectId: 'project-one', displayName: 'Before', fullPath: '/workspace/old' };
let rejectSave = false;
let saved: unknown;
beforeEach(() => {
  rejectSave = false; saved = undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/settings')) {
      if (rejectSave) return new Response(JSON.stringify({ error: { code: 'PROJECT_BUSY', message: 'Busy' } }), { status: 409 });
      saved = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ project: { ...project, ...(saved as object), fullPath: '/workspace/new' } }));
    }
    if (url.endsWith('/github-credential')) return new Response(JSON.stringify({ credentialId: 7 }));
    return new Response(JSON.stringify({ credentials: [{ id: 7, credential_name: 'Account A', is_active: true }, { id: 8, credential_name: 'Account B', is_active: true }] }));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('edits directory, name and credential together and refreshes the selected project', async () => {
  const onSaved = vi.fn(), onClose = vi.fn();
  render(<ProjectSettingsModal project={project} onClose={onClose} onSaved={onSaved} />);
  await waitFor(() => expect((screen.getByLabelText('GitHub credential') as HTMLSelectElement).value).toBe('7'));
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'After' } });
  fireEvent.change(screen.getByLabelText('Project directory'), { target: { value: '/workspace/new' } });
  fireEvent.change(screen.getByLabelText('GitHub credential'), { target: { value: '8' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save project' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'After', fullPath: '/workspace/new' })));
  expect(saved).toEqual({ displayName: 'After', path: '/workspace/new', credentialId: 8 });
  expect(onClose).toHaveBeenCalled();
});

test('preserves unsaved edits and leaves the dialog open when the project is running', async () => {
  rejectSave = true;
  const onSaved = vi.fn(), onClose = vi.fn();
  render(<ProjectSettingsModal project={project} onClose={onClose} onSaved={onSaved} />);
  await waitFor(() => expect((screen.getByLabelText('GitHub credential') as HTMLSelectElement).value).toBe('7'));
  fireEvent.change(screen.getByLabelText('Project directory'), { target: { value: '/workspace/new' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save project' }));
  expect((await screen.findByRole('alert')).textContent).toContain('This project has running sessions');
  expect((screen.getByLabelText('Project directory') as HTMLInputElement).value).toBe('/workspace/new');
  expect(onSaved).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
});
