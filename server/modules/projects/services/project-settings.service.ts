import fs from 'node:fs/promises';
import { getConnection, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { setProjectGithubCredential, validateProjectGithubCredential } from '@/modules/github-auth/index.js';
import { sessionExecutionService, providerRuntimeService } from '@/modules/providers/index.js';
import { AppError, normalizeProjectPath, validateWorkspacePath } from '@/shared/index.js';

type SettingsInput = { userId: number; projectId: string; displayName: string; projectPath: string; credentialId: number | null };

/** Used by Projects routes to change metadata and working directory atomically without moving files. */
export async function updateProjectSettings(input: SettingsInput) {
  const existing = projectsDb.getProjectById(input.projectId);
  if (!existing) throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  validateProjectGithubCredential(input.userId, input.credentialId);
  const validation = await validateWorkspacePath(input.projectPath);
  if (!validation.valid || !validation.resolvedPath) throw new AppError('Invalid project directory', { code: 'INVALID_PROJECT_PATH', statusCode: 400 });
  const projectPath = normalizeProjectPath(validation.resolvedPath);
  const changingDirectory = projectPath !== existing.project_path;
  if (changingDirectory) {
    const stat = await fs.stat(projectPath).catch(() => null);
    if (!stat?.isDirectory()) throw new AppError('Select an existing project directory. Files are not moved automatically.', { code: 'PROJECT_DIRECTORY_MISSING', statusCode: 400 });
  }
  // No async gap between checking active owners and committing the directory change.
  return getConnection().transaction(() => {
    const current = projectsDb.getProjectById(input.projectId);
    if (current?.project_path !== existing.project_path) throw new AppError('Project changed; reopen its settings', { code: 'PROJECT_CHANGED', statusCode: 409 });
    const conflict = projectsDb.getProjectPath(projectPath);
    if (conflict && conflict.project_id !== input.projectId) throw new AppError('Directory already belongs to another project', { code: 'PROJECT_ALREADY_EXISTS', statusCode: 409 });
    if (changingDirectory) {
      const busy = sessionsDb.getSessionsByProjectPathIncludingArchived(existing.project_path).some(session =>
        sessionExecutionService.get(session.session_id) || providerRuntimeService.hasBackgroundWork(session.session_id));
      if (busy) throw new AppError('This project still has running sessions. Stop them before changing its directory.', { code: 'PROJECT_BUSY', statusCode: 409 });
      projectsDb.updateProjectDirectory(input.projectId, projectPath);
    }
    setProjectGithubCredential(input.userId, input.projectId, input.credentialId);
    projectsDb.updateCustomProjectNameById(input.projectId, input.displayName.trim() || null);
    return { projectId: input.projectId, path: projectPath, fullPath: projectPath, displayName: input.displayName.trim() || projectPath.split('/').pop() };
  })();
}
