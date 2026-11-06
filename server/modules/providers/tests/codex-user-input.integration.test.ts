import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexLiveClient } from '@/modules/providers/list/codex/codex-live.client.js';
import { createCodexLiveRuntime } from '@/modules/providers/list/codex/codex-live-runtime.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

// Opt-in installed-CLI test; all model traffic stays on a loopback fixture.
test('real Codex async question renders, survives turn completion, and receives the selected answer', {
  skip: process.env.CLOUDCLI_TEST_CODEX_QUESTIONS !== '1', timeout: 45_000,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-codex-queue-'));
  const requests: string[] = [];
  const responses: ServerResponse[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: `response-${requests.length}` } })}\n\n`);
    responses.push(res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  await writeFile(path.join(directory, 'config.toml'), `model_provider = "queueprobe"\nmodel = "gpt-6-astra"\n[model_providers.queueprobe]\nname = "queueprobe"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\n`);
  const frames: AnyRecord[] = [];
  let processCount = 0;
  const runtime = createCodexLiveRuntime((notify, fail, _environment, onRequest) => {
    processCount++;
    return new CodexLiveClient(notify, fail, process.env.CLOUDCLI_TEST_CODEX_LAUNCHER ?? createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js'), {
      PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory,
    }, onRequest);
  });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null, resolveResumeModel: async () => 'gpt-6-astra',
    getProviderModels: async () => ({ DEFAULT: 'gpt-6-astra', OPTIONS: [] }),
    normalizeMessage: raw => [{ ...(raw as AnyRecord), kind: 'text' } as never], isProviderInstalled: async () => true,
  };
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, `Native dispatch timed out after ${requests.length} model requests: ${JSON.stringify(frames.slice(-2))}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const complete = (index: number, ask = false) => {
    const message = ask ? { type: 'function_call', id: 'question-item', call_id: 'question-call', name: 'request_user_input_async', arguments: JSON.stringify({ questions: [{ title: 'Which action should I take?', options: ['Keep the existing content', 'Stop and preserve evidence'] }] }) } : { type: 'message', id: `answer-${index}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Response ${index}` }] };
    for (const event of [
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: `response-${index}`, status: 'completed', output: [message], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ]) responses[index].write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    responses[index].end();
  };
  const running = runtime.run('Initial local test message.', { sessionId: 'isolated-native-queue', cwd: directory, permissionMode: 'bypassPermissions' }, {
    isWebSocketWriter: true, send: message => frames.push(message as AnyRecord),
  }, context);
  try {
    await until(() => responses.length === 1);
    complete(0, true);
    await until(() => runtime.permissions.listPending('isolated-native-queue').length === 1);
    const [request] = runtime.permissions.listPending('isolated-native-queue');
    assert.equal(request.input.questions[0].options[1].label, 'Stop and preserve evidence');
    assert.equal(frames.find(frame => frame.kind === 'permission_request')?.requestId, request.requestId);
    await until(() => responses.length === 2);
    complete(1);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(frames.some(frame => frame.kind === 'complete'), false, 'async question must remain answerable after the original turn ends');
    runtime.permissions.resolve(request.requestId, { allow: true, updatedInput: {
      answers: { [request.input.questions[0].id]: 'Stop and preserve evidence' },
    } });
    await until(() => responses.length === 3);
    assert.ok(requests[2].includes('Stop and preserve evidence'));
    complete(2);
    await running;
    assert.equal(runtime.permissions.listPending('isolated-native-queue').length, 0);
    assert.equal(frames.some(frame => frame.kind === 'permission_resolved'), true);
    assert.equal(processCount, 1);
    assert.equal(frames.filter(frame => frame.kind === 'complete').length, 1);
    assert.equal(frames.filter(frame => frame.kind === 'error').length, 0);

  } finally {
    runtime.abort('isolated-native-queue');
    await running;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
