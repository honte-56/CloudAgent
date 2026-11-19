import assert from 'node:assert/strict';
import test from 'node:test';

import { runProjectRemoteOperation } from '@/modules/git/git-remote.service.js';
import { AppError } from '@/shared/index.js';

function fixture() {
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const selections: Array<[number, string]> = [];
  const environment = { GH_TOKEN: 'bound-test-token', CLOUDCLI_GITHUB_TOKEN: 'bound-test-token', GIT_CONFIG_COUNT: '5' };
  const dependencies: Parameters<typeof runProjectRemoteOperation>[1] = {
    resolveProjectPath: async id => `/projects/${id}`,
    validateRepository: async () => {},
    getCurrentBranch: async () => 'feature/local',
    validateBranch: () => {},
    validateRemote: () => {},
    resolveAuthentication: async (user, projectPath) => {
      selections.push([user, projectPath]);
      return { environment, instructions: '' };
    },
    runCommand: async (_command, args, options) => {
      calls.push({ args, env: options.env });
      return { stdout: args[0] === 'rev-parse' ? 'honte/feature/remote\n' : args[0] === 'remote' ? 'honte\n' : '', stderr: '' };
    },
  };
  return { calls, selections, dependencies, environment };
}

for (const action of ['fetch', 'pull', 'push', 'publish'] as const) {
  test(`${action} resolves the authenticated user's project credential and passes it only to Git`, async () => {
    const { calls, selections, dependencies, environment } = fixture();
    const before = { ...process.env };
    const result = await runProjectRemoteOperation({ action, userId: 7, projectId: 'repo', branch: 'feature/local' }, dependencies);
    assert.equal(result.success, true);
    assert.deepEqual(selections, [[7, '/projects/repo']]);
    assert.ok(calls.every(call => call.env === environment));
    const expected = {
      fetch: ['fetch', 'honte'],
      pull: ['pull', 'honte', 'feature/remote'],
      push: ['push', 'honte', 'HEAD:refs/heads/feature/remote'],
      publish: ['push', '--set-upstream', 'honte', 'feature/local'],
    };
    assert.deepEqual(calls.at(-1)?.args, expected[action]);
    assert.ok(!JSON.stringify(calls.map(call => call.args)).includes('bound-test-token'));
    assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(before), 'The service environment must remain unchanged');
  });

  test(`${action} never falls back when a bound credential is unavailable`, async () => {
    const { calls, dependencies } = fixture();
    dependencies.resolveAuthentication = async () => { throw new AppError('Bound credential is disabled', { code: 'PROJECT_GITHUB_CREDENTIAL_UNAVAILABLE', statusCode: 409 }); };
    await assert.rejects(runProjectRemoteOperation({ action, userId: 7, projectId: 'repo' }, dependencies), { code: 'PROJECT_GITHUB_CREDENTIAL_UNAVAILABLE', statusCode: 409 });
    assert.deepEqual(calls, []);
  });
}

test('unbound projects retain the environment without mutating the service process', async () => {
  const { calls, dependencies } = fixture();
  dependencies.resolveAuthentication = async () => null;
  await runProjectRemoteOperation({ action: 'push', userId: 7, projectId: 'repo' }, dependencies);
  assert.equal(calls.at(-1)?.env?.GIT_TERMINAL_PROMPT, '0');
  assert.equal(calls.at(-1)?.env?.PATH, process.env.PATH);
  assert.notEqual(calls.at(-1)?.env, process.env);
});

test('a 403 in stderr is classified and returned with redacted details, with no retry', async () => {
  const { calls, dependencies } = fixture();
  const runCommand = dependencies.runCommand;
  dependencies.runCommand = async (command, args, options) => {
    if (args[0] !== 'push') return runCommand(command, args, options);
    calls.push({ args, env: options.env });
    throw Object.assign(new Error('Command failed: git push honte main'), {
      stderr: 'remote: Permission to org/repo.git denied to wrong-user.\nfatal: HTTP 403 https://user:embedded-secret@github.com/org/repo bound-test-token',
    });
  };
  await assert.rejects(runProjectRemoteOperation({ action: 'push', userId: 7, projectId: 'repo' }, dependencies), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'GIT_REMOTE_AUTH_FAILED');
    assert.match(String(error.details), /denied to wrong-user/);
    assert.match(String(error.details), /403/);
    assert.doesNotMatch(JSON.stringify(error), /bound-test-token|embedded-secret/);
    return true;
  });
  assert.equal(calls.filter(call => call.args[0] === 'push').length, 1);
});

test('concurrent projects do not share credential environments', async () => {
  const { calls, dependencies } = fixture();
  dependencies.resolveAuthentication = async (userId, projectPath) => ({
    environment: { CLOUDCLI_GITHUB_TOKEN: `${userId}:${projectPath}` }, instructions: '',
  });
  await Promise.all([7, 8].map(userId => runProjectRemoteOperation({ action: 'push', userId, projectId: `repo-${userId}` }, dependencies)));
  assert.deepEqual(calls.filter(call => call.args[0] === 'push').map(call => call.env?.CLOUDCLI_GITHUB_TOKEN).sort(), ['7:/projects/repo-7', '8:/projects/repo-8']);
});

test('unauthenticated requests cannot resolve credentials or launch Git', async () => {
  const { calls, selections, dependencies } = fixture();
  await assert.rejects(runProjectRemoteOperation({ action: 'push', userId: NaN, projectId: 'repo' }, dependencies), { statusCode: 401 });
  assert.deepEqual(calls, []);
  assert.deepEqual(selections, []);
});

test('a missing upstream uses origin while unrelated upstream failures abort', async () => {
  for (const missing of [true, false]) {
    const { calls, dependencies } = fixture();
    const run = dependencies.runCommand;
    dependencies.runCommand = async (command, args, options) => {
      if (args[0] === 'rev-parse') throw Object.assign(new Error('Command failed'), { stderr: missing ? 'fatal: no upstream configured for branch' : 'fatal: unable to read config: Permission denied' });
      return run(command, args, options);
    };
    const result = runProjectRemoteOperation({ action: 'push', userId: 7, projectId: 'repo' }, dependencies);
    if (missing) {
      await result;
      assert.deepEqual(calls.at(-1)?.args, ['push', 'origin', 'HEAD:refs/heads/feature/local']);
    } else {
      await assert.rejects(result);
      assert.deepEqual(calls, []);
    }
  }
});
