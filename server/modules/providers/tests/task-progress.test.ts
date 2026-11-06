import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskProgressService } from '@/modules/providers/services/task-progress.service.js';
import type { AnyRecord, NormalizedMessage } from '@/shared/types.js';

const childId = '11111111-1111-4111-8111-111111111111';
function fixture(directory: string, launch: Partial<NormalizedMessage>, providerExtras: AnyRecord = {}) {
  const parent = { session_id: 'parent', provider: 'claude', provider_session_id: 'native-parent', project_path: directory };
  const child = { session_id: 'child-app', provider: 'codex', provider_session_id: childId, project_path: directory };
  const readIds: string[] = [];
  const childRows: NormalizedMessage[] = [{ id: 'progress', sessionId: 'child-app', kind: 'text', provider: 'codex', role: 'assistant', content: 'Working on the packager', timestamp: '2026-11-04T00:00:00Z' }];
  const service = createTaskProgressService({
    getSession: () => parent as never, getNativeSession: id => id === childId ? child as never : null,
    history: async id => { readIds.push(id); return { messages: id === 'parent' ? [{ id: 'launch', sessionId: 'parent', timestamp: '2026-11-04T00:00:00Z', provider: 'claude', kind: 'tool_use', toolId: 'tool-1', toolName: 'Bash', ...launch }] as NormalizedMessage[] : [...childRows], total: 1, hasMore: false, offset: 0, limit: null }; },
    provider: () => ({ runtime: { run() { throw new Error('Viewing must not start a runtime'); }, listBackgroundWork: () => [{ sessionId: 'parent', tasks: [{ toolUseId: 'tool-1' }] }] }, sessions: providerExtras }) as never,
  });
  return { service, readIds, childRows };
}

test('a redirected Codex log resolves the exact child session and refreshes it without starting another instance', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'task-progress-'));
  try {
    await writeFile(path.join(dir, 'handoff.log'), `OpenAI Codex\nsession id: ${childId}\nStarting…\n`);
    const f = fixture(dir, { toolInput: { command: `cd '${dir}' && codex exec -m model 'task' > '${dir}/handoff.log' 2>&1`, description: 'Packager' } });
    const first = await f.service.read('parent', 'tool-1');
    assert.equal(first.kind, 'conversation'); assert.equal(first.childSessionId, 'child-app');
    assert.equal(first.messages?.[0].content, 'Working on the packager');
    f.childRows.push({ ...f.childRows[0], id: 'new', content: 'Tests passed' });
    const second = await f.service.read('parent', 'tool-1');
    assert.equal(second.messages?.at(-1)?.content, 'Tests passed');
    assert.deepEqual(f.readIds, ['parent', 'child-app', 'parent', 'child-app']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('plain commands show output; ambiguous or unrelated thread IDs never pick a nearby conversation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'task-output-'));
  try {
    const file = path.join(dir, 'command.log'); await writeFile(file, 'step 1\nstep 2');
    const f = fixture(dir, { toolInput: { command: `some-command > ${file}` } });
    assert.equal((await f.service.read('parent', 'tool-1')).output, 'step 1\nstep 2');
    await writeFile(file, `session id: ${childId}\nsession id: 22222222-2222-4222-8222-222222222222\n`);
    assert.equal((await f.service.read('parent', 'tool-1')).kind, 'command');
    await assert.rejects(f.service.read('parent', 'some-other-task'), /任务记录/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an external redirected log supplies the conversation when the SDK output is empty', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'task-project-'));
  const logs = await mkdtemp(path.join(os.tmpdir(), 'task-external-logs-'));
  const taskRoot = path.join(os.tmpdir(), `claude-${process.getuid?.() ?? 0}`);
  await mkdir(taskRoot, { recursive: true });
  const sdkDirectory = await mkdtemp(path.join(taskRoot, 'task-progress-'));
  try {
    const tasks = path.join(sdkDirectory, 'native-parent', 'tasks');
    await mkdir(tasks, { recursive: true });
    const sdkOutput = path.join(tasks, 'background.output');
    await writeFile(sdkOutput, '');
    const log = path.join(logs, 'codex run.log');
    await writeFile(log, `OpenAI Codex\nsession id: ${childId}\nStarting…\n`);
    const f = fixture(dir, {
      toolInput: { command: `cd '${dir}-worktree' && codex exec - < /tmp/prompt.md > '${log}' 2>&1` },
      toolResult: { content: `Command running in background with ID: background. Output is being written to: ${sdkOutput}`, toolUseResult: { backgroundTaskId: 'background' } },
    });
    const first = await f.service.read('parent', 'background');
    assert.equal(first.kind, 'conversation');
    assert.equal(first.provider, 'codex');
    assert.equal(first.childSessionId, 'child-app');
    assert.equal(first.messages?.[0].content, 'Working on the packager');
    f.childRows.push({ ...f.childRows[0], id: 'new', content: 'Still working' });
    assert.equal((await f.service.read('parent', 'tool-1')).messages?.at(-1)?.content, 'Still working');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(logs, { recursive: true, force: true });
    await rm(sdkDirectory, { recursive: true, force: true });
  }
});

test('external logs are read only at literal destinations and cannot redirect through file symlinks', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'task-project-'));
  const logs = await mkdtemp(path.join(os.tmpdir(), 'task-external-logs-'));
  try {
    const log = path.join(logs, 'command.log');
    const other = path.join(logs, 'other.log');
    await writeFile(log, 'real command output');
    await writeFile(other, 'UNRELATED_CONTENT');
    const f = fixture(dir, { toolInput: { command: `command > '${log}'` } });
    assert.equal((await f.service.read('parent', 'tool-1')).output, 'real command output');
    await rm(log);
    assert.equal((await f.service.read('parent', 'tool-1')).output, '');
    await symlink(other, log);
    assert.equal((await f.service.read('parent', 'tool-1')).output, '');
    for (const destination of [`${logs}/*.log`, `${logs}/$FILE.log`, `${logs}/\`filename\`.log`]) {
      const dynamic = fixture(dir, { toolInput: { command: `command > ${destination}` } });
      assert.equal((await dynamic.service.read('parent', 'tool-1')).output, '');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(logs, { recursive: true, force: true });
  }
});

test('a symlink outside the parent project is not exposed by task output inspection', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'task-output-boundary-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'task-unrelated-'));
  try {
    await writeFile(path.join(outside, 'unrelated.log'), 'PRIVATE_UNRELATED_CONTENT');
    await symlink(path.join(outside, 'unrelated.log'), path.join(dir, 'output.log'));
    const f = fixture(dir, { toolInput: { command: `command > ${dir}/output.log` } });
    assert.equal((await f.service.read('parent', 'tool-1')).output, '');
  } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('native subagents read their own timeline even when the parent history is unchanged', async () => {
  let reads = 0;
  const f = fixture('/tmp', { toolName: 'Agent', subagent: { id: 'agent-1', status: 'running' } }, {
    readSubagentActivity: async (_parent: string, id: string) => { assert.equal(id, 'agent-1'); return { agent: { id, status: 'running' }, activity: [{ kind: 'text', content: `progress-${++reads}` }], activityCount: reads }; },
  });
  assert.equal((await f.service.read('parent', 'tool-1')).activity?.[0].content, 'progress-1');
  assert.equal((await f.service.read('parent', 'tool-1')).activity?.[0].content, 'progress-2');
});

test('workflow membership refreshes independently and cannot select an unrelated agent', async () => {
  const agents = [{ id: 'first', status: 'completed' }];
  const f = fixture('/tmp', { toolName: 'Workflow', workflow: { runId: 'run', status: 'running', agents: [] } as never }, {
    readWorkflowAgents: async () => [...agents],
    readWorkflowAgentActivity: async (_parent: string, _run: string, id: string) => ({
      agent: { id, status: 'running' }, activity: [{ kind: 'text', content: id }], activityCount: 1,
    }),
  });
  assert.equal((await f.service.read('parent', 'tool-1')).selectedAgentId, 'first');
  agents.push({ id: 'second', status: 'running' });
  const latest = await f.service.read('parent', 'tool-1');
  assert.equal(latest.selectedAgentId, 'second');
  assert.equal(latest.activity?.[0].content, 'second');
  assert.equal((await f.service.read('parent', 'tool-1', { agentId: 'first' })).selectedAgentId, 'first');
  await assert.rejects(f.service.read('parent', 'tool-1', { agentId: 'unrelated' }), /does not belong/);
});
