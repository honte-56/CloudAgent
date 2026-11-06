import express from 'express';
import projectsRouter from '@/modules/projects/projects.routes.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getConnection, closeConnection, initializeDatabase, projectsDb, sessionsDb, credentialsDb } from '@/modules/database/index.js';
import { getProjectGithubCredential } from '@/modules/github-auth/index.js';
import { sessionExecutionService } from '@/modules/providers/index.js';
import { createProject } from '@/modules/projects/services/project-management.service.js';
import { WORKSPACES_ROOT } from '@/shared/utils.js';
import { updateProjectSettings } from '@/modules/projects/services/project-settings.service.js';

test('project settings preserve credentials and histories across directory changes and rescans', async () => {
  const root = await mkdtemp(path.join(WORKSPACES_ROOT, '.project-settings-test-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'test.db');
  try {
    await writeFile(process.env.DATABASE_PATH, '');
    await initializeDatabase();
    const db = getConnection();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'owner', 'unused'), (2, 'other', 'unused')").run();
    const token = Number(credentialsDb.createCredential(1, 'account', 'github_token', 'test-only-value').id);
    const foreign = Number(credentialsDb.createCredential(2, 'other', 'github_token', 'other-test-value').id);
    const app = express();
    app.use(express.json(), (req, _res, next) => { Object.assign(req, { user: { id: 1 } }); next(); });
    app.use('/api/projects', projectsRouter);
    app.use((error: { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.statusCode || 500).json({ code: error.code }); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as { port: number };
    const request = (payload: object) => fetch(`http://127.0.0.1:${address.port}/api/projects/create-project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    try {
      for (const githubTokenId of [-1, '1', 1.2]) {
        assert.equal((await request({ path: path.join(root, 'invalid'), githubTokenId })).status, 400);
      }
      assert.equal((await request({ path: path.join(root, 'invalid'), newGithubToken: 123 })).status, 400);
      assert.equal((await request({ path: path.join(root, 'invalid'), githubTokenId: token, newGithubToken: 'conflicting' })).status, 400);
      assert.equal((await request({ path: path.join(root, 'invalid'), githubUrl: 'https://github.com/example/repo' })).status, 400);
      const response = await request({ path: path.join(root, 'api-created'), githubTokenId: token });
      assert.equal(response.status, 200);
      const data = await response.json() as { project: { projectId: string } };
      assert.equal(getProjectGithubCredential(1, data.project.projectId).credentialId, token);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    const oldPath = path.join(root, 'old');
    const target = path.join(root, 'target');
    await mkdir(target);
    const result = await createProject({ projectPath: oldPath, github: { userId: 1, credentialId: token, inlineToken: null } });
    const id = result.project.projectId;
    assert.equal(getProjectGithubCredential(1, id).credentialId, token);
    assert.equal(JSON.stringify(result).includes('test-only-value'), false);
    await assert.rejects(createProject({ projectPath: path.join(root, 'denied'), github: { userId: 1, credentialId: foreign, inlineToken: null } }), { code: 'PROJECT_GITHUB_CREDENTIAL_UNAVAILABLE' });
    await assert.rejects(access(path.join(root, 'denied')));
    const sessionId = sessionsDb.createSession('native-history', 'claude', oldPath, 'old session', undefined, undefined, '/old/transcript.jsonl');
    const settings = { userId: 1, projectId: id, displayName: 'Renamed', projectPath: target, credentialId: token };
    const lease = sessionExecutionService.claim({ sessionId, provider: 'claude', kind: 'terminal', stop() {} });
    await assert.rejects(updateProjectSettings(settings), { code: 'PROJECT_BUSY' });
    assert.equal(projectsDb.getProjectPathById(id), oldPath);
    lease.release();
    await assert.rejects(updateProjectSettings({ ...settings, projectPath: path.join(root, 'missing') }), { code: 'PROJECT_DIRECTORY_MISSING' });
    await updateProjectSettings(settings);
    assert.equal(projectsDb.getProjectPathById(id), target);
    assert.equal(sessionsDb.getSessionById(sessionId)?.project_path, target);
    assert.equal(sessionsDb.getSessionById(sessionId)?.jsonl_path, '/old/transcript.jsonl');
    sessionsDb.createSession('native-history', 'claude', oldPath, 'rescan', undefined, undefined, '/old/transcript.jsonl');
    assert.equal(sessionsDb.getSessionById(sessionId)?.project_path, target, 'old transcript cwd must not undo the move');
    assert.equal(projectsDb.getProjectPath(oldPath), null, 'rescan must not recreate the original project');
    assert.equal(getProjectGithubCredential(1, id).credentialId, token);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    await assert.rejects(updateProjectSettings({ ...settings, displayName: 'Should not save', credentialId: foreign }), { code: 'PROJECT_GITHUB_CREDENTIAL_UNAVAILABLE' });
    assert.equal(projectsDb.getProjectById(id)?.custom_project_name, 'Renamed');
    const other = await createProject({ projectPath: path.join(root, 'other') });
    await assert.rejects(updateProjectSettings({ ...settings, projectPath: other.project.path }), { code: 'PROJECT_ALREADY_EXISTS' });
    const inline = await createProject({ projectPath: path.join(root, 'inline'), github: { userId: 1, credentialId: null, inlineToken: 'inline-test-value' } });
    assert.equal(getProjectGithubCredential(1, inline.project.projectId).configured, true);
    // A binding write failure rolls project registration back rather than reporting a partially created project.
    db.exec("CREATE TRIGGER reject_binding BEFORE INSERT ON project_github_credentials BEGIN SELECT RAISE(ABORT, 'test rejection'); END");
    await assert.rejects(createProject({ projectPath: path.join(root, 'rollback'), github: { userId: 1, credentialId: token, inlineToken: null } }));
    assert.equal(projectsDb.getProjectPath(path.join(root, 'rollback')), null);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
