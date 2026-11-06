import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexUserInputBridge } from '@/modules/providers/list/codex/codex-user-input.provider.js';
import type { AnyRecord } from '@/shared/types.js';

function fixture() {
  const events: AnyRecord[] = [], replies: AnyRecord[] = [], answered: unknown[][] = [];
  const bridge = createCodexUserInputBridge('app-session', event => events.push(event), (...args) => answered.push(args));
  return { bridge, events, replies, answered, reply: (result: AnyRecord) => { replies.push(result); } };
}

test('async Codex options stay pending, replay on reconnect and return native question IDs exactly once', () => {
  const f = fixture();
  assert.equal(f.bridge.handle('item/tool/requestUserInput', { isBlocking: false, questions: [
    { id: 'q1', question: 'Choose', options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] },
    { id: 'q2', question: 'Choose', options: null },
  ] }, f.reply, 42), true);
  assert.equal(f.replies.length, 0, 'never automatically select a suggested option');
  assert.equal(f.bridge.pending, true);
  const [request] = f.bridge.list();
  assert.equal(request.toolName, 'AskUserQuestion');
  assert.equal(request.input.questions[0].options[1].label, 'B');
  assert.deepEqual(request.input.questions[1].options, []);
  f.bridge.resolve(request.requestId, { allow: true, updatedInput: { answers: { q1: 'B', q2: 'custom answer' } } });
  f.bridge.resolve(request.requestId, { allow: true, updatedInput: { answers: { q1: 'A' } } });
  assert.deepEqual(f.replies, [{ answers: { q1: { answers: ['B'] }, q2: { answers: ['custom answer'] } } }]);
  assert.deepEqual(f.answered, [[false, true, false]]);
  assert.equal(f.bridge.pending, false);
  assert.equal(f.events.at(-1)?.kind, 'permission_resolved');
});

test('skip, native cancellation, and stopped runs retract questions without inventing answers', () => {
  const f = fixture();
  const params = { isBlocking: true, questions: [{ id: 'q', question: 'Confirm?', options: ['Yes', 'No'] }] };
  f.bridge.handle('item/tool/requestUserInput', params, f.reply, 'native-1');
  f.bridge.resolve(f.bridge.list()[0].requestId, { allow: true, updatedInput: { answers: {} } });
  assert.deepEqual(f.replies, [{ answers: {} }]);
  f.bridge.handle('item/tool/requestUserInput', params, f.reply, 'native-2');
  f.bridge.resolvedByNative('native-2');
  assert.equal(f.bridge.list().length, 0);
  assert.equal(f.events.at(-1)?.kind, 'permission_cancelled');
  f.bridge.handle('item/tool/requestUserInput', params, f.reply, 'native-3');
  f.bridge.clear();
  assert.equal(f.bridge.pending, false);
  assert.equal(f.replies.length, 1);
  assert.equal(f.bridge.handle('item/commandExecution/requestApproval', {}, f.reply, 99), false);
});

test('transport failure retains the pending question instead of claiming that the answer was sent', () => {
  const f = fixture();
  f.bridge.handle('item/tool/requestUserInput', { questions: [{ id: 'q', question: 'Continue?', options: null }] }, () => { throw new Error('closed'); }, 1);
  assert.throws(() => f.bridge.resolve(f.bridge.list()[0].requestId, { allow: true, updatedInput: { answers: { q: 'Yes' } } }), /closed/);
  assert.equal(f.bridge.pending, true);
  assert.equal(f.events.some(event => event.kind === 'permission_resolved'), false);
});

test('async answer delivery keeps the card until confirmation and ignores duplicate clicks', async () => {
  const f = fixture();
  let accepted!: () => void;
  let calls = 0;
  f.bridge.handle('item/tool/requestUserInput', { asyncMessage: true, isBlocking: false, questions: [{ id: 'q', question: 'Choose?', options: ['A', 'B'] }] },
    () => { calls++; return new Promise<void>(resolve => { accepted = resolve; }); }, 'message-id');
  const id = f.bridge.list()[0].requestId;
  const decision = { allow: true, updatedInput: { answers: { q: 'B' } } };
  f.bridge.resolve(id, decision);
  f.bridge.resolve(id, decision);
  assert.equal(calls, 1);
  assert.equal(f.bridge.pending, true);
  accepted();
  await new Promise(setImmediate);
  assert.equal(f.bridge.pending, false);
  assert.deepEqual(f.answered, [[false, true, true]]);
});
