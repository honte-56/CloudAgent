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
for (const promote of [false, true]) test(`real Codex CLI ${promote ? 'echoes send-now on receipt' : 'drains two native queued messages'} without replacing its process`, {
  skip: process.env.CLOUDCLI_TEST_CODEX_QUEUE !== '1', timeout: 45_000,
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
  await writeFile(path.join(directory, 'config.toml'), `model_provider = "queueprobe"\nmodel = "gpt-5.4"\n[model_providers.queueprobe]\nname = "queueprobe"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\n`);
  const frames: AnyRecord[] = [];
  let processCount = 0;
  const runtime = createCodexLiveRuntime((notify, fail) => {
    processCount++;
    return new CodexLiveClient(notify, fail, createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js'), {
      PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory,
    });
  });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null, resolveResumeModel: async () => 'gpt-5.4',
    getProviderModels: async () => ({ DEFAULT: 'gpt-5.4', OPTIONS: [] }),
    normalizeMessage: raw => [{ ...(raw as AnyRecord), kind: 'text' } as never], isProviderInstalled: async () => true,
  };
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, `Native dispatch timed out after ${requests.length} model requests: ${JSON.stringify(frames.slice(-2))}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const complete = (index: number) => {
    const message = { type: 'message', id: `answer-${index}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Response ${index}` }] };
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
    const first = await runtime.queue.add('isolated-native-queue', 'FIRST_NATIVE_QUEUE', [], '11111111-1111-4111-8111-111111111111');
    const second = await runtime.queue.add('isolated-native-queue', 'SECOND_NATIVE_QUEUE', [], '22222222-2222-4222-8222-222222222222');
    assert.equal((await runtime.queue.list('isolated-native-queue')).length, 2);
    if (promote) {
      await runtime.queue.cancel('isolated-native-queue', first.id);
      await runtime.queue.sendNow('isolated-native-queue', second.id);
      assert.equal(responses.length, 1, 'model has not consumed the supplemental text yet');
      assert.equal(frames.some(frame => frame.role === 'user' && frame.content === 'SECOND_NATIVE_QUEUE'), true, 'accepted input must be visible immediately');
      complete(0);
      await until(() => responses.length === 2);
      assert.ok(requests[1].includes('SECOND_NATIVE_QUEUE'));
      complete(1);
    } else {
      complete(0);
      await until(() => responses.length === 2);
      assert.ok(requests[1].includes('FIRST_NATIVE_QUEUE'));
      assert.equal(frames.some(frame => frame.kind === 'complete'), false);
      complete(1);
      await until(() => responses.length === 3 || frames.some(frame => frame.kind === 'complete'));
      assert.equal(responses.length, 3);
      assert.ok(requests[2].includes('SECOND_NATIVE_QUEUE'));
      complete(2);
    }
    await running;
    assert.equal(processCount, 1);
    assert.equal(frames.filter(frame => frame.kind === 'complete').length, 1);
    assert.equal(frames.filter(frame => frame.kind === 'error').length, 0);
    assert.equal(new Set(frames.filter(frame => frame.kind === 'text' && frame.role === 'user').map(frame => frame.id)).size, promote ? 1 : 2);
  } finally {
    runtime.abort('isolated-native-queue');
    await running;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
