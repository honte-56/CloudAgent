import assert from 'node:assert/strict';
import test from 'node:test';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import { createSessionExecutionRegistry } from '@/modules/providers/services/session-execution.service.js';
import type { IProvider, IProviderRuntime } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';

function createRuntime(overrides: Partial<IProviderRuntime> = {}): IProviderRuntime {
  return {
    async run() {
      return undefined;
    },
    abort() {
      return false;
    },
    ...overrides,
  };
}

function createProvider(id: LLMProvider, runtime: IProviderRuntime): IProvider {
  return {
    id,
    runtime,
    auth: {
      async getStatus() {
        return {
          provider: id,
          installed: true,
          authenticated: true,
          method: 'test',
          details: {},
        };
      },
    },
    sessions: {
      normalizeMessage(raw: unknown, sessionId: string | null) {
        return [{ kind: 'assistant', content: String(raw), sessionId, provider: id }];
      },
      async fetchHistory() {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      },
    },
  } as unknown as IProvider;
}

function createService(providers: IProvider[], overrides: Parameters<typeof createProviderRuntimeService>[0] = {}) {
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  return createProviderRuntimeService({
    execution: createSessionExecutionRegistry(id => `native-${id}`),
    listProviders: () => providers,
    resolveProvider(providerName) {
      const provider = providerMap.get(providerName as LLMProvider);
      if (!provider) {
        throw new Error(`Missing provider: ${providerName}`);
      }
      return provider;
    },
    resolveProviderSessionId: (sessionId) => sessionId ? `native-${sessionId}` : null,
    async resolveResumeModel(_provider, _sessionId, requestedModel) {
      return requestedModel?.trim() || undefined;
    },
    async getProviderModels() {
      return {
        OPTIONS: [],
        DEFAULT: 'default-model',
      };
    },
    ...overrides,
  });
}

test('providerRegistry owns one runtime for every registered provider', () => {
  const providers = providerRegistry.listProviders();

  assert.deepEqual(providers.map((provider) => provider.id), [
    'claude',
    'codex',
    'cursor',
    'opencode',
  ]);
  assert.equal(providers.every((provider) => typeof provider.runtime.run === 'function'), true);
  assert.equal(providers.every((provider) => typeof provider.runtime.abort === 'function'), true);
});

test('foreground completion does not release execution while background work is still alive', async () => {
  const execution = createSessionExecutionRegistry(id => `native-${id}`);
  let finish!: () => void;
  let aborted = 0;
  const runtime = createRuntime({
    async run(_command, _options, writer) {
      writer.send({ kind: 'complete' });
      await new Promise<void>(resolve => { finish = resolve; });
    },
    abort() { aborted++; finish(); return true; },
  });
  const service = createService([createProvider('claude', runtime)], { execution });
  const running = service.run('claude', 'start monitor', { sessionId: 'owned' }, { send() {} });
  assert.equal(execution.get('owned')?.kind, 'chat');
  assert.throws(() => execution.claim({ sessionId: 'owned', provider: 'claude', kind: 'terminal', stop() {} }), /running in chat/);
  await execution.stop('owned', execution.get('owned')!.id);
  await running;
  assert.equal(aborted, 1);
  assert.equal(execution.get('owned'), null);
});

test('chat cannot launch over a retained terminal or use a cancelled reservation', async () => {
  const execution = createSessionExecutionRegistry(() => 'native');
  let launches = 0;
  const service = createService([createProvider('claude', createRuntime({ async run() { launches++; } }))], { execution });
  const terminal = execution.claim({ sessionId: 'owned', provider: 'claude', kind: 'terminal', stop() {} });
  assert.throws(() => service.reserveRun('claude', 'owned'), /running in the terminal/);
  assert.equal(launches, 0);
  terminal.release();
  const reservation = service.reserveRun('claude', 'owned');
  await execution.stop('owned', execution.get('owned')!.id);
  await assert.rejects(reservation.run('do not launch', { sessionId: 'owned' }, { send() {} }), /ownership was transferred/);
  assert.equal(launches, 0);
});

test('dispatches runs and aborts through the runtime owned by providerRegistry', async () => {
  const calls: unknown[][] = [];
  const runtime = createRuntime({
    async run(command, options, writer, context) {
      calls.push(['run', command, options, writer]);
      assert.equal(context.resolveProviderSessionId('session-1'), 'native-session-1');
      assert.equal(await context.resolveResumeModel('session-1', 'sonnet'), 'sonnet');
      assert.deepEqual(await context.getProviderModels(), { OPTIONS: [], DEFAULT: 'default-model' });
      assert.equal(context.normalizeMessage('hello', 'session-1')[0]?.provider, 'claude');
      assert.equal(await context.isProviderInstalled(), true);
      return 'complete';
    },
    async abort(sessionId) {
      calls.push(['abort', sessionId]);
      return true;
    },
  });
  const service = createService([createProvider('claude', runtime)]);
  const writer = { send() {} };

  assert.equal(service.hasRuntime('claude'), true);
  assert.equal(service.hasRuntime('unknown'), false);
  assert.equal(await service.getRunner('claude')('hello', { model: 'sonnet' }, writer), 'complete');
  assert.equal(await service.abort('claude', 'session-1'), true);
  assert.deepEqual(calls, [
    ['run', 'hello', { model: 'sonnet' }, writer],
    ['abort', 'session-1'],
  ]);
});

test('routes permission decisions through provider-owned runtime capabilities', () => {
  const decisions: unknown[][] = [];
  const claudeRuntime = createRuntime({
    permissions: {
      resolve(requestId, decision) {
        decisions.push([requestId, decision]);
      },
      listPending(sessionId) {
        return [{ requestId: 'request-1', sessionId }];
      },
    },
  });
  const service = createService([
    createProvider('claude', claudeRuntime),
    createProvider('cursor', createRuntime()),
  ]);
  const decision = { allow: true, message: 'approved' };

  service.resolveToolApproval('request-1', decision);

  assert.deepEqual(decisions, [['request-1', decision]]);
  assert.deepEqual(service.getPendingApprovalsForSession('session-1'), [
    { requestId: 'request-1', sessionId: 'session-1' },
  ]);
});

test('steering resolves the provider from the session and does not run or abort it', async (t) => {
  const { sessionsDb } = await import('@/modules/database/index.js');
  t.mock.method(sessionsDb, 'getSessionById', () => ({ provider: 'codex' }) as never);
  const calls: unknown[] = [];
  const runtime = createRuntime({
    steer: async (id, content) => { calls.push([id, content]); },
    run: async () => { throw new Error('Must not restart'); },
    abort: () => { throw new Error('Must not abort'); },
  });
  await createService([createProvider('codex', runtime)]).steer('app-id', 'new direction');
  assert.deepEqual(calls, [['app-id', 'new direction']]);
});

test('steering rejects missing sessions and unsupported providers without dispatch', async (t) => {
  const { sessionsDb } = await import('@/modules/database/index.js');
  const lookup = t.mock.method(sessionsDb, 'getSessionById', () => null as never);
  const service = createService([createProvider('codex', createRuntime())]);
  await assert.rejects(service.steer('missing', 'input'), (error: any) => error.statusCode === 404);
  lookup.mock.mockImplementation(() => ({ provider: 'codex' }) as never);
  await assert.rejects(service.steer('app-id', 'input'), (error: any) => error.statusCode === 409 && error.code === 'STEER_UNSUPPORTED');
});

test('HTTP steering resumes only after the adapter proves the old input is closed', async t => {
  const { sessionsDb } = await import('@/modules/database/index.js');
  t.mock.method(sessionsDb, 'getSessionById', () => ({ provider: 'claude' }) as never);
  const calls: unknown[] = [];
  const runtime = createRuntime({ prepareInput: async () => 'resume', steer: async () => { throw new Error('Closed input must not receive text'); } });
  const service = createService([createProvider('claude', runtime)], {
    startResumedTurn: async (...args) => { calls.push(args); },
  });
  await service.steer('app-id', 'recover this input', [], undefined, 7);
  assert.deepEqual(calls, [['app-id', 'recover this input', [], 7]]);
});


test('live input validates attachment paths before reaching a provider', async (t) => {
  const { sessionsDb } = await import('@/modules/database/index.js');
  const { getGlobalImageAssetsDir } = await import('@/shared/image-attachments.js');
  t.mock.method(sessionsDb, 'getSessionById', () => ({ provider: 'claude' }) as never);
  const calls: unknown[] = [];
  const service = createService([createProvider('claude', createRuntime({ steer: async (...args) => { calls.push(args); } }))]);
  const attachment = { path: getGlobalImageAssetsDir() + '/report.docx', name: 'report.docx' };
  await service.steer('app-id', '', [attachment]);
  assert.deepEqual(calls, [['app-id', '', [attachment]]]);
  await assert.rejects(service.steer('app-id', '', [{ path: '/etc/passwd' }]), (error: any) => error.code === 'INVALID_ATTACHMENT');
  assert.equal(calls.length, 1);
});

for (const outcome of ['delivered', 'claimed', 'changed', 'rejected'] as const) {
  test(`queued live input shares the dispatcher claim: ${outcome}`, async (t) => {
    const { sessionsDb, sessionDraftsDb } = await import('@/modules/database/index.js');
    t.mock.method(sessionsDb, 'getSessionById', () => ({ provider: 'claude' }) as never);
    const queued = { content: outcome === 'changed' ? 'edited on another device' : 'queued input', attachments: [] };
    const candidate = { userId: 7, sessionId: 'app-id', queuedMessage: queued, claimToken: JSON.stringify(queued) };
    t.mock.method(sessionDraftsDb, 'listQueuedMessages', () => [candidate]);
    const claim = t.mock.method(sessionDraftsDb, 'claimQueuedMessage', () => outcome !== 'claimed');
    const restore = t.mock.method(sessionDraftsDb, 'restoreQueuedMessage', (_candidate: Parameters<typeof sessionDraftsDb.restoreQueuedMessage>[0]) => {});
    const cleanup = t.mock.method(sessionDraftsDb, 'deleteEmptyDraft', () => {});
    let calls = 0;
    const service = createService([createProvider('claude', createRuntime({ steer: async () => {
      calls++;
      assert.equal(claim.mock.callCount(), 1, 'claim must precede injection');
      if (outcome === 'rejected') throw new Error('not accepting live input');
    } }))]);
    if (outcome === 'delivered') {
      await service.steer('app-id', 'queued input', [], 7);
      assert.equal(cleanup.mock.callCount(), 1);
    } else {
      await assert.rejects(service.steer('app-id', 'queued input', [], 7), (error: any) =>
        error.code === (outcome === 'rejected' ? 'STEER_FAILED' : 'QUEUE_CHANGED'));
    }
    assert.equal(calls, ['delivered', 'rejected'].includes(outcome) ? 1 : 0);
    assert.equal(restore.mock.callCount(), outcome === 'rejected' ? 1 : 0);
    if (outcome === 'rejected') {
      assert.equal(JSON.parse(restore.mock.calls[0].arguments[0].claimToken).deliveryError, 'not accepting live input');
    }
  });
}
