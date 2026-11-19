import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import express from 'express';

import { createGitRouter } from '@/modules/git/git.routes.js';
import { AppError } from '@/shared/index.js';

test('all remote HTTP actions use server-authenticated project selection and return Git diagnostics', async () => {
  const calls: Array<{ args: string[]; environment?: NodeJS.ProcessEnv }> = [];
  const selections: Array<[number, string]> = [];
  let disabled = false;
  let denied = false;
  const providerUsers: unknown[] = [];
  const spawnProcess = ((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ args, environment: options.env });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    process.nextTick(() => {
      if (args.includes('--is-inside-work-tree')) child.stdout.write('true\n');
      if (args.includes('--show-toplevel')) child.stdout.write('/workspace/repo\n');
      if (args[0] === 'symbolic-ref') child.stdout.write('main\n');
      if (args.includes('main@{upstream}')) child.stdout.write('honte/main\n');
      if (args[0] === 'remote') child.stdout.write('honte\n');
      if (args[0] === 'status') child.stdout.write(' M tracked.txt\0');
      if (args[0] === 'diff') child.stdout.write('+changed text\n');
      if (args[0] === 'push' && denied) child.stderr.write('remote: Permission denied to wrong-user. HTTP 403\n');
      child.emit('close', args[0] === 'push' && denied ? 128 : 0);
    });
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const provider: Parameters<typeof createGitRouter>[0]['queryClaude'] = async (_command, _options, writer) => {
    providerUsers.push(writer.userId);
    if (disabled) throw new AppError('Bound credential disabled', { code: 'PROJECT_GITHUB_CREDENTIAL_UNAVAILABLE', statusCode: 409 });
    writer.send({ type: 'text', text: 'fix: update tracked file' });
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { user: { id: 7 } }); next(); });
  app.use(createGitRouter({
    fileSystem: { access: async () => {} } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: id => id === 'repo-id' ? '/workspace/repo' : null,
    resolveProjectAuthentication: async (userId, projectPath) => {
      selections.push([userId, projectPath]);
      if (disabled) throw new AppError('Bound credential disabled', { code: 'PROJECT_GITHUB_CREDENTIAL_UNAVAILABLE', statusCode: 409 });
      return { environment: { CLOUDCLI_GITHUB_TOKEN: 'route-test-token' }, instructions: '' };
    },
    queryClaude: provider,
    queryCursor: provider,
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const request = (action: string, body: Record<string, unknown>) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    for (const action of ['fetch', 'pull', 'push', 'publish']) {
      const response = await request(action, { project: 'repo-id', branch: 'main', userId: 999, credentialId: 999 });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { success: boolean }).success, true);
      assert.deepEqual(selections.at(-1), [7, '/workspace/repo']);
      assert.equal(calls.at(-1)?.environment?.CLOUDCLI_GITHUB_TOKEN, 'route-test-token');
    }
    disabled = true;
    const before = calls.length;
    const failedBinding = await request('push', { project: 'repo-id' });
    assert.equal(failedBinding.status, 409);
    assert.equal((await failedBinding.json() as { code: string }).code, 'PROJECT_GITHUB_CREDENTIAL_UNAVAILABLE');
    assert.equal(calls.length, before);
    disabled = false;
    denied = true;
    const failedPush = await request('push', { project: 'repo-id' });
    assert.equal(failedPush.status, 500);
    const error = await failedPush.json() as { code: string; details: string };
    assert.equal(error.code, 'GIT_REMOTE_AUTH_FAILED');
    assert.match(error.details, /403/);
    assert.match(error.details, /wrong-user/);
    assert.ok(!JSON.stringify(error).includes('route-test-token'));
    const invalidRequest = await request('push', { project: { id: 'repo-id' } });
    assert.equal(invalidRequest.status, 400);
    for (const provider of ['claude', 'cursor']) {
      const suggestion = await request('generate-commit-message', { project: 'repo-id', files: ['tracked.txt'], provider, userId: 999 });
      assert.equal(suggestion.status, 200);
      assert.equal((await suggestion.json() as { message: string }).message, 'fix: update tracked file');
      assert.equal(providerUsers.at(-1), 7);
    }
    disabled = true;
    const failedSuggestion = await request('generate-commit-message', { project: 'repo-id', files: ['tracked.txt'] });
    assert.equal(failedSuggestion.status, 409);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
