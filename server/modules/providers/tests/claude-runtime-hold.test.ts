import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  claudeRuntime,
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  stopClaudeSDKTask,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The runtime keeps the CLI's stdin open after a turn's `result` while the
 * turn's background work is outstanding, and lets go when that work has
 * reported. These drive `queryClaudeSDK` with a scripted SDK stream — the
 * seam is `context.createQuery` — and watch the held prompt stream: the CLI
 * exits when it ends, so "released" is the whole outcome.
 */

const SESSION_ID = 'app-hold-session';
const NATIVE_ID = 'native-hold-session';

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  stopped: string[];
  inputs: Record<string, unknown>[];
  interrupts: number;
  queries: number;
  closes: number;
};

/** A stand-in for the SDK query: yields what the test emits, and reads the held prompt to notice its release. */
function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  const stopped: string[] = [];

  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    released: () => released,
    stopped, inputs: [], interrupts: 0, queries: 0, closes: 0,
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    script.queries++;
    const stdin = { writableEnded: false, destroyed: false };
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null });
    void (async () => {
      for await (const message of prompt) { script.inputs.push(message as Record<string, unknown>); }
      released = true;
      stdin.writableEnded = true;
    })();

    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();

    return Object.assign(iterator, {
      transport: { processStdin: stdin, process: child },
      isClosed: () => script.closes > 0,
      close: () => {
        script.closes++;
        setTimeout(() => { script.end(); child.exitCode = 0; child.emit('exit', 0, null); }, 20);
      },
      interrupt: async () => { script.interrupts++; },
      stopTask: async (taskId: string) => { stopped.push(taskId); },
    });
  };

  return { createQuery, script };
}

async function withRun(
  runTest: (context: { script: Scripted; sent: NormalizedMessage[]; done: Promise<unknown>; nativeIds: string[] }) => Promise<void>,
  previousNativeId: string | null = null,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const nativeIds: string[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, setSessionId: (id: string) => nativeIds.push(id), userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => previousNativeId,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd, resumeFromScratch: Boolean(previousNativeId) }, writer as never, context);
    await waitFor(() => script.inputs.length === 1);
    await runTest({ script, sent, done, nativeIds });
    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

// A fixed settle can be too short on a loaded machine; the supersede tests
// wait for the run to have actually processed its turn instead.
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await settle();
  }
  assert.ok(condition(), 'condition never became true');
}

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const ack = (id: string, text: string, toolUseResult: Record<string, unknown>) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  tool_use_result: toolUseResult,
});
const taskStarted = (taskId: string, toolUseId: string, taskType: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: taskType,
});
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status, summary: `Task ${taskId} ${status}`, output_file: '',
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'launched', duration_ms: 1, num_turns: 1 });

const cliState = (state: 'idle' | 'running') => ({ type: 'system', subtype: 'session_state_changed', state, session_id: NATIVE_ID });

test('input preparation keeps a healthy CLI and only releases a proven EOF before resume', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    await settle();
    assert.equal(await claudeRuntime.prepareInput(SESSION_ID), 'live');
    assert.equal(script.closes, 0);
    script.emit(result());
    script.emit(cliState('idle'));
    await waitFor(() => script.released());
    // Legacy stranded process: stdin ended, but a later task is still alive.
    script.emit(taskStarted('late-task', 'late-tool', 'local_bash'));
    await settle();
    const first = claudeRuntime.prepareInput(SESSION_ID);
    const second = claudeRuntime.prepareInput(SESSION_ID);
    assert.deepEqual(await Promise.all([first, second]), ['resume', 'resume']);
    assert.equal(script.closes, 1);
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
  });
});

test('a Monitor expiry does not close input before the CLI rearms it and accepts a follow-up', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(cliState('running'));
    script.emit(toolUse('old-monitor', 'Monitor', { command: 'sleep 90', timeout_ms: 1000 }));
    script.emit(taskStarted('old-task', 'old-monitor', 'local_bash'));
    script.emit(result());
    // CLI can be idle between notifications while the monitor remains alive.
    // That idle event is no longer evidence of idleness after it expires.
    script.emit(cliState('idle'));
    await settle();
    // Real CLI 2.1.316: timeout emits stopped, then queues a turn to rearm.
    script.emit({ type: 'system', subtype: 'task_updated', task_id: 'old-task', patch: { status: 'killed' } });
    script.emit(taskNotification('old-task', 'old-monitor', 'stopped'));
    await settle();
    assert.equal(script.released(), false, 'stopped is a task event, not proof the CLI is idle');
    script.emit(init());
    script.emit(toolUse('new-monitor', 'Monitor', { command: 'sleep 90' }));
    script.emit(taskStarted('new-task', 'new-monitor', 'local_bash'));
    script.emit(result());
    await settle();
    assert.equal(claudeRuntime.canSteer(SESSION_ID), true);
    const sending = claudeRuntime.steer(SESSION_ID, 'Can these jobs run together?');
    await waitFor(() => script.inputs.length === 2);
    script.emit({ ...script.inputs[1], session_id: NATIVE_ID, isReplay: true });
    await sending;
    assert.equal(script.queries, 1);
    assert.deepEqual(script.stopped, []);
    assert.equal(script.interrupts, 0);
  });
});

test('a result between Monitor expiry and its queued follow-up is not an input-close signal', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(cliState('running'));
    script.emit(toolUse('monitor', 'Monitor', { command: 'sleep 90', timeout_ms: 1000 }));
    script.emit(taskStarted('task', 'monitor', 'local_bash'));
    script.emit(taskNotification('task', 'monitor', 'stopped'));
    script.emit(result());
    await settle();
    assert.equal(script.released(), false, 'CLI still has a queued notification turn');
    script.emit(result());
    script.emit(cliState('idle'));
    await waitFor(() => script.released());
  });
});

test('an idle event cannot close input while an accepted attachment is being prepared', async (t) => {
  let finishRead: (() => void) | undefined;
  const original = fs.realpath;
  t.mock.method(fs, 'realpath', async (...args: Parameters<typeof original>) => {
    if (String(args[0]).endsWith('/pending-attachment.png')) {
      await new Promise<void>(resolve => { finishRead = resolve; });
      throw new Error('test image missing');
    }
    return original(...args);
  });
  await withRun(async ({ script }) => {
    script.emit(init());
    await settle();
    const sending = claudeRuntime.steer(SESSION_ID, 'read this attachment', [{ path: 'pending-attachment.png', mimeType: 'image/png' }]);
    void sending.catch(() => {});
    await waitFor(() => Boolean(finishRead));
    script.emit(result());
    script.emit(cliState('idle'));
    await settle();
    assert.equal(script.released(), false);
    finishRead?.();
    await waitFor(() => script.inputs.length === 2);
    script.emit({ ...script.inputs[1], session_id: NATIVE_ID, isReplay: true });
    await sending;
    assert.equal(script.queries, 1);
  });
});

test('stopping the last outstanding task releases the held process', async () => {
  await withRun(async ({ script, sent, done }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // The turn is over for the client, the process is held for the workflow.
    assert.ok(sent.some((message) => message.kind === 'complete'));
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => [entry.sessionId, entry.tasks.map((task) => task.taskId)]), [[SESSION_ID, ['wf1']]]);
    assert.equal(script.released(), false, 'stdin stays open while the workflow runs');

    // The user stops it. The CLI answers with a `stopped` notification and
    // pushes no follow-up turn, so nothing else would ever end the hold.
    assert.equal(await stopClaudeSDKTask(SESSION_ID, 'wf1'), true);
    assert.deepEqual(script.stopped, ['wf1']);
    script.emit(taskNotification('wf1', 'toolu_wf', 'stopped'));
    script.emit(cliState('idle'));
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'the process is let go once nothing is outstanding');
    void done;
  });
});

test('a task that reported completed keeps the hold for the turn that relays its result', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // Completed, unlike stopped, is followed by a turn the CLI pushes to relay
    // the result; closing stdin at the notification would cut it short.
    script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    await settle();
    assert.equal(script.released(), false);

    script.emit(result());
    script.emit(cliState('idle'));
    await settle();
    assert.equal(script.released(), true, 'the follow-up turn\'s result ends the hold');
  });
});

test('an agent that ran in the foreground and settled before the result does not hold the process', async () => {
  await withRun(async ({ script }) => {
    // An Agent call without `run_in_background` is scored as background by
    // the static rule, but the CLI ran it in the foreground: its task started
    // and settled before the turn ended. The task events know that.
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'Return the word FOUR', subagent_type: 'general-purpose' }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(ack('toolu_agent', 'FOUR', { status: 'completed', agentId: 'a1' }));
    script.emit(result());
    script.emit(cliState('idle'));
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'nothing is outstanding, so nothing to hold for');
  });
});

test('a new turn stops the tasks the held process still has going before letting it go', async () => {
  // Two runs on one session, each with its own scripted CLI: the first is
  // held for a background agent, the second is the user's next message.
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: first.createQuery });
    await settle();
    first.script.emit(init());
    first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    first.script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.equal(first.script.released(), false, 'the first process is held for its agent');

    // Closing stdin alone would leave the CLI waiting for the agent, so the
    // superseded process would live on next to the new one for as long as
    // the agent runs. The stop has to reach it before stdin ends, because the
    // SDK drops control requests written to an ended stdin.
    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: second.createQuery });
    await settle();
    assert.deepEqual(first.script.stopped, ['a1'], 'the held process is told to stop its agent');
    assert.equal(first.script.released(), true, 'and is then let go');
    assert.deepEqual(second.script.stopped, [], 'the new process is untouched');

    first.script.emit(taskNotification('a1', 'toolu_agent', 'stopped'));
    first.script.end();
    await firstRun;
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a held process is still let go when stopping its tasks throws', async () => {
  // Stopping is best effort; a stop that throws on the spot must not keep the
  // held process alive or take the new turn down with it.
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
  const throwingStop: NonNullable<ProviderRuntimeContext['createQuery']> = (options) =>
    Object.assign(first.createQuery(options), {
      stopTask: () => { throw new Error('stop failed'); },
    });

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: throwingStop });
    await settle();
    first.script.emit(init());
    first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    first.script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.equal(first.script.released(), false, 'the first process is held for its agent');

    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: second.createQuery });
    await settle();
    assert.equal(first.script.released(), true, 'the held process is let go anyway');

    first.script.end();
    await firstRun;
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    await waitFor(() => second.script.released());
    assert.equal(second.script.released(), true, 'the new turn ran to completion');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a turn whose tool emits no task events still holds on the static rule', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(ack('toolu_monitor', 'Monitor started', {}));
    script.emit(result());
    await settle();

    assert.equal(script.released(), false, 'Monitor reports no task, so the launch rule decides');
  });
});

for (const background of [false, true]) {
  test(`live input uses the same ${background ? 'background-held' : 'foreground'} CLI and leaves its task running`, async () => {
    await withRun(async ({ script, sent }) => {
      script.emit(init());
      script.emit(toolUse('toolu_shell', 'Bash', { command: 'sleep 90', run_in_background: true }));
      script.emit(taskStarted('shell1', 'toolu_shell', 'local_bash'));
      if (background) script.emit(result());
      await settle();
      const completedBefore = sent.filter((message) => message.kind === 'complete').length;
      let delivered = false;
      const sending = claudeRuntime.steer(SESSION_ID, 'continue without interrupting').then(() => { delivered = true; });
      await waitFor(() => script.inputs.length === 2);
      const input = script.inputs[1];
      assert.equal(delivered, false, 'stdin consumption is not a CLI receipt');
      assert.equal(input.priority, 'next');
      assert.equal(script.queries, 1);
      assert.equal(script.interrupts, 0);
      assert.deepEqual(script.stopped, []);
      assert.equal(script.released(), false);
      assert.equal(listClaudeSDKBackgroundWork()[0].tasks[0].taskId, 'shell1');
      // The preceding result must not close stdin before the follow-up is read.
      script.emit(result());
      await settle();
      assert.equal(script.released(), false);
      assert.equal(sent.filter((message) => message.kind === 'complete').length, completedBefore);
      script.emit({ ...input, session_id: NATIVE_ID, isReplay: true });
      await sending;
      assert.equal(delivered, true);
      script.emit(result());
      await settle();
      assert.equal(sent.filter((message) => message.kind === 'complete').length, completedBefore + 1);
      assert.equal(script.released(), false, 'background task still owns its process');
      script.emit(taskNotification('shell1', 'toolu_shell', 'completed'));
      script.emit(result());
      script.emit(cliState('idle'));
      await settle();
      assert.equal(script.released(), true);
      await assert.rejects(claudeRuntime.steer(SESSION_ID, 'too late'), /no longer accepting/);
    });
  });
}

test('CLI exit rejects a live send without a receipt and never starts a replacement', async () => {
  await withRun(async ({ script, done }) => {
    script.emit(init());
    await settle();
    const rejected = assert.rejects(claudeRuntime.steer(SESSION_ID, 'pending'), /stopped before acknowledging/);
    await waitFor(() => script.inputs.length === 2);
    script.end();
    await done;
    await rejected;
    assert.equal(script.queries, 1);
    await assert.rejects(claudeRuntime.steer(SESSION_ID, 'late'), /No active Claude/);
  });
});

test('stopping the last background task cannot close an active live follow-up', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(taskStarted('shell1', 'toolu_shell', 'local_bash'));
    script.emit(result());
    await settle();
    const sending = claudeRuntime.steer(SESSION_ID, 'answer while it stops');
    await waitFor(() => script.inputs.length === 2);
    script.emit({ ...script.inputs[1], session_id: NATIVE_ID, isReplay: true });
    await sending;
    script.emit(taskNotification('shell1', 'toolu_shell', 'stopped'));
    await settle();
    assert.equal(script.released(), false);
    script.emit(result());
    script.emit(cliState('idle'));
    await settle();
    assert.equal(script.released(), true);
  });
});


test('a quiet background monitor keeps accepting follow-ups after the idle ceiling', async (t) => {
  const original = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timer = original(callback, ms, ...args);
    if (ms === 30 * 60 * 1000) expire = () => { clearTimeout(timer); callback(...args); };
    return timer;
  });
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(taskStarted('monitor', 'tool_monitor', 'local_bash'));
    script.emit(result());
    await waitFor(() => Boolean(expire));
    for (let i = 0; i < 3; i++) expire!();
    await settle();
    assert.equal(script.released(), false);
    assert.equal(claudeRuntime.canSteer(SESSION_ID), true);
    const sending = claudeRuntime.steer(SESSION_ID, 'progress?');
    await waitFor(() => script.inputs.length === 2);
    script.emit({ ...script.inputs[1], session_id: NATIVE_ID, isReplay: true });
    await sending;
    assert.equal(script.queries, 1);
    assert.deepEqual(script.stopped, []);
    assert.equal(script.interrupts, 0);
  });
});

test('live document input carries the uploaded path through the same CLI', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    const sending = claudeRuntime.steer(SESSION_ID, 'read this', [{ path: '/tmp/report.docx', name: 'report.docx' }]);
    await waitFor(() => script.inputs.length === 2);
    const input = script.inputs[1];
    assert.match(String((input.message as { content: unknown }).content), /<files_input>[\s\S]*report\.docx/);
    script.emit({ ...input, session_id: NATIVE_ID, isReplay: true });
    await sending;
    assert.equal(script.queries, 1);
  });
});

test('a CLI public progress update survives the live SDK stream as visible assistant text', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit({
      type: 'assistant', session_id: NATIVE_ID, uuid: 'visible-progress', thinkingDisplay: 'updates',
      message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '第 1 步修复已在本地提交。' }] },
    });
    await waitFor(() => sent.some(message => message.id === 'visible-progress_0'));
    const update = sent.find(message => message.id === 'visible-progress_0');
    assert.equal(update?.kind, 'text');
    assert.equal(update?.role, 'assistant');
    assert.equal(update?.content, '第 1 步修复已在本地提交。');
  });
});

test('first-prompt replay adopts the new main session id and ignores subagent ids', async () => {
  await withRun(async ({ script, nativeIds }) => {
    script.emit({ ...init(), session_id: 'child-before-init', parent_tool_use_id: 'tool-parent' });
    script.emit(init());
    await waitFor(() => nativeIds.length > 0);
    assert.deepEqual(nativeIds, [NATIVE_ID]);
    script.emit({ ...init(), session_id: 'child-after-init', parent_tool_use_id: 'tool-parent' });
    script.emit(init());
    await settle();
    assert.deepEqual(nativeIds, [NATIVE_ID]);
    assert.equal(script.queries, 1);
    assert.equal(claudeRuntime.canSteer(SESSION_ID), true);
  }, 'previous-native-id');
});
