import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';

async function fixture(provider: string, rows: object[], run: (id: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fork-boundaries-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, ''); await initializeDatabase();
  const file = path.join(directory, 'session.jsonl');
  await writeFile(file, rows.map((row, i) => JSON.stringify({ timestamp: new Date(Date.UTC(2026, 10, 3, 0, 0, i)).toISOString(), ...row })).join('\n') + '\n');
  sessionsDb.createSession('source', provider, directory, 'Source', undefined, undefined, file);
  try { await run('source'); }
  finally { closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; await rm(directory, { recursive: true, force: true }); }
}

test('Codex user and assistant rows share a completed-turn fork point, including typed-only replies', async () => {
  await fixture('codex', [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-one' } },
    { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-one', item: { type: 'UserMessage', content: [{ type: 'Text', text: 'first prompt' }] } } },
    { type: 'response_item', payload: { type: 'message', id: 'answer-one', role: 'assistant', content: [{ type: 'output_text', text: 'first answer' }] } },
    { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-one', item: { type: 'AgentMessage', id: 'answer-one', content: [{ type: 'Text', text: 'first answer' }] } } },
    { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-one', item: { type: 'AgentMessage', id: 'typed-only', content: [{ type: 'Text', text: 'typed reply' }] } } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-one' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-two' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'still running' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'working…' }] } },
  ], async id => {
    const result = await new CodexSessionsProvider().fetchHistory(id);
    const text = result.messages.filter(message => message.kind === 'text');
    assert.equal(text.filter(message => message.content === 'first answer').length, 1, 'wire and typed copies must not duplicate');
    assert.deepEqual(text.slice(0, 3).map(message => message.forkAnchorId), ['turn-one', 'turn-one', 'turn-one']);
    assert.deepEqual(text.slice(3).map(message => message.forkAnchorId), [undefined, undefined]);
    assert.equal(text[0].transcriptAnchorId, 'turn-one', 'editing remains anchored to the first prompt');
  });
});

test('Claude forks a complete tool round through its final reply, preserving separate edit anchors', async () => {
  const row = (type: string, uuid: string, parentUuid: string | null, content: unknown, stop_reason?: string) => ({ type, uuid, parentUuid, sessionId: 'source', message: { role: type, content, stop_reason } });
  await fixture('claude', [
    row('user', 'question', null, 'first prompt'),
    row('assistant', 'tool', 'question', [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'read', name: 'Read', input: {} }], 'tool_use'),
    row('user', 'result', 'tool', [{ type: 'tool_result', tool_use_id: 'read', content: 'done' }]),
    row('assistant', 'answer', 'result', [{ type: 'text', text: 'complete answer' }], 'end_turn'),
    row('user', 'next', 'answer', 'next prompt'),
    row('assistant', 'ongoing', 'next', [{ type: 'tool_use', id: 'read2', name: 'Read', input: {} }], 'tool_use'),
  ], async id => {
    const result = await new ClaudeSessionsProvider({ getLiveRunStartTime: () => null }).fetchHistory(id);
    const first = result.messages.find(message => message.role === 'user' && message.content === 'first prompt');
    assert.equal(first?.transcriptAnchorId, 'question');
    assert.equal(first?.forkAnchorId, 'answer');
    assert.equal(result.messages.find(message => message.content === 'complete answer')?.forkAnchorId, 'answer');
    assert.equal(result.messages.find(message => message.content === 'next prompt')?.forkAnchorId, undefined);
  });
});

test('nested Codex branches expand only their frozen parent prefixes', async () => {
  await fixture('codex', [], async id => {
    const source = sessionsDb.getSessionById(id)!;
    const directory = path.dirname(source.jsonl_path!);
    const line = (payload: object) => JSON.stringify(payload) + '\n';
    const completed = (turn: string, text: string) => [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
      { type: 'event_msg', payload: { type: 'user_message', message: text } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } },
    ].map(line).join('');
    const first = completed('kept-turn', '保留的父会话消息');
    const parentPath = path.join(directory, 'parent.jsonl');
    await writeFile(parentPath, first + completed('later-turn', '不应带入的后续消息'));
    sessionsDb.createSession('parent', 'codex', directory, 'Parent', undefined, undefined, parentPath);
    const child = line({ type: 'session_meta', payload: { history_base: { thread_id: 'parent', end_byte_offset: Buffer.byteLength(first) } } })
      + completed('child-turn', '分支自己的消息');
    const childPath = path.join(directory, 'child.jsonl'); await writeFile(childPath, child);
    sessionsDb.createSession('child', 'codex', directory, 'Child', undefined, undefined, childPath);
    await writeFile(source.jsonl_path!, line({ type: 'session_meta', payload: { history_base: { thread_id: 'child', end_byte_offset: Buffer.byteLength(child) } } }));
    const result = await new CodexSessionsProvider().fetchHistory(id);
    assert.deepEqual(result.messages.filter(message => message.role === 'user').map(message => message.content), ['保留的父会话消息', '分支自己的消息']);
    assert.deepEqual(result.messages.filter(message => message.role === 'user').map(message => message.forkAnchorId), ['kept-turn', 'child-turn']);
  });
});
