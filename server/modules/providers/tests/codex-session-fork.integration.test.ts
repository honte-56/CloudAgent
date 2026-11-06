import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { CodexLiveClient } from '@/modules/providers/list/codex/codex-live.client.js';
import { CodexForkProvider } from '@/modules/providers/list/codex/codex-fork.provider.js';

test('real Codex forks through a completed turn and resumes the copy without changing the original', { skip: process.env.CLOUDCLI_TEST_FORKS !== '1', timeout: 40_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-fork-native-'));
  const workspace = path.join(directory, 'workspace'); await mkdir(workspace);
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = directory;
  const previousDatabase = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, ''); await initializeDatabase();
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; requests.push(body);
    const message = { type: 'message', id: `msg-${requests.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `ANSWER_${requests.length}` }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id: `response-${requests.length}` } },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: `response-${requests.length}`, status: 'completed', output: [message], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  await writeFile(path.join(directory, 'config.toml'), `model_provider = "forkprobe"\nmodel = "gpt-5.4"\n[model_providers.forkprobe]\nname = "forkprobe"\nbase_url = "http://127.0.0.1:${(server.address() as { port: number }).port}/v1"\nwire_api = "responses"\n`);
  const completed = new Set<string>();
  const errors: Error[] = [];
  const client = new CodexLiveClient((method, params) => { if (method === 'turn/completed') completed.add(params.turn.id); }, error => errors.push(error), undefined,
    { PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory });
  const turn = async (threadId: string, text: string) => {
    const result = await client.call('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
    const deadline = Date.now() + 10_000;
    while (!completed.has(result.turn.id)) { assert.ok(Date.now() < deadline, JSON.stringify(errors)); await new Promise(resolve => setTimeout(resolve, 10)); }
    return result.turn.id as string;
  };
  try {
    await client.initialize();
    const source = (await client.call('thread/start', { cwd: workspace, model: 'gpt-5.4', approvalPolicy: 'never', sandbox: 'read-only' })).thread;
    const firstTurn = await turn(source.id, 'KEEP_FIRST_PROMPT');
    await turn(source.id, 'EXCLUDE_LATER_PROMPT');
    const original = await readFile(source.path, 'utf8');
    const fork = await new CodexForkProvider().forkSession({ providerSessionId: source.id, jsonlPath: source.path, projectPath: workspace, upToAnchorId: firstTurn });
    assert.notEqual(fork.providerSessionId, source.id);
    const copy = await readFile(fork.jsonlPath, 'utf8');
    // Verify resumed model context below, not the physical rollout layout.
    assert.equal(copy.includes('EXCLUDE_LATER_PROMPT'), false);
    sessionsDb.createSession(source.id, 'codex', workspace, 'Source', undefined, undefined, source.path);
    sessionsDb.createSession(fork.providerSessionId, 'codex', workspace, 'Branch', undefined, undefined, fork.jsonlPath);
    const history = await new CodexSessionsProvider().fetchHistory(fork.providerSessionId);
    assert.ok(history.messages.some(message => message.content === 'KEEP_FIRST_PROMPT'));
    assert.ok(history.messages.some(message => message.content === 'ANSWER_1'));
    assert.equal(history.messages.some(message => message.content === 'EXCLUDE_LATER_PROMPT'), false);
    assert.ok(history.messages.some(message => message.forkAnchorId === firstTurn), 'inherited completed turns remain forkable');
    await client.call('thread/resume', { threadId: fork.providerSessionId, cwd: workspace });
    await turn(fork.providerSessionId, 'CONTINUE_BRANCH');
    assert.ok(requests[2].includes('KEEP_FIRST_PROMPT') && requests[2].includes('ANSWER_1'));
    assert.equal(requests[2].includes('EXCLUDE_LATER_PROMPT'), false);
    assert.equal(await readFile(source.path, 'utf8'), original);
    assert.equal(errors.length, 0);
  } finally {
    client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    closeConnection(); if (previousDatabase === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabase;
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
