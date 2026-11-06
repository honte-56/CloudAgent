import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeForkProvider } from '@/modules/providers/list/claude/claude-fork.provider.js';

test('real Claude fork preserves the selected prefix, remaps IDs, and resumes independently', { skip: process.env.CLOUDCLI_TEST_FORKS !== '1', timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-fork-native-'));
  const workspace = path.join(directory, 'workspace');
  const config = path.join(directory, 'claude');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  const project = path.join(config, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(project, { recursive: true }); await mkdir(workspace);
  const source = randomUUID(), prompt = randomUUID(), answer = randomUUID(), later = randomUUID();
  const original = [
    { type: 'user', uuid: prompt, parentUuid: null, message: { role: 'user', content: 'KEEP_THIS_PROMPT' } },
    { type: 'assistant', uuid: answer, parentUuid: prompt, message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'KEEP_THIS_ANSWER' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'user', uuid: later, parentUuid: answer, message: { role: 'user', content: 'EXCLUDE_THIS_LATER_PROMPT' } },
  ].map((row, i) => JSON.stringify({ ...row, cwd: workspace, sessionId: source, isSidechain: false, timestamp: new Date(Date.UTC(2026, 10, 3, 0, 0, i)).toISOString(), version: '2.1.0' })).join('\n') + '\n';
  const sourcePath = path.join(project, `${source}.jsonl`);
  await writeFile(sourcePath, original);
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    if (request.url?.includes('count_tokens')) { response.end('{"input_tokens":10}'); return; }
    requests.push(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of [
      { type: 'message_start', message: { id: 'msg_branch', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Independent branch response.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const fork = await new ClaudeForkProvider().forkSession({ providerSessionId: source, jsonlPath: sourcePath, projectPath: workspace, upToAnchorId: answer, title: 'Independent branch' });
    assert.notEqual(fork.providerSessionId, source);
    const copied = await readFile(fork.jsonlPath, 'utf8');
    assert.ok(copied.includes('KEEP_THIS_PROMPT') && copied.includes('KEEP_THIS_ANSWER'));
    assert.equal(copied.includes('EXCLUDE_THIS_LATER_PROMPT'), false);
    const rows = copied.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.some(row => row.uuid === prompt || row.uuid === answer), false);
    let completed = false;
    for await (const message of query({ prompt: 'Continue this branch.', options: {
      resume: fork.providerSessionId, cwd: workspace, model: 'claude-sonnet-4-6', maxTurns: 1,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, ANTHROPIC_API_KEY: 'local-test-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      settingSources: [], mcpServers: {}, strictMcpConfig: true, tools: [],
    } })) if (message.type === 'result') completed = true;
    assert.equal(completed, true);
    assert.ok(requests.some(body => body.includes('KEEP_THIS_PROMPT') && body.includes('KEEP_THIS_ANSWER')));
    assert.equal(requests.some(body => body.includes('EXCLUDE_THIS_LATER_PROMPT')), false);
    assert.equal(await readFile(sourcePath, 'utf8'), original);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
