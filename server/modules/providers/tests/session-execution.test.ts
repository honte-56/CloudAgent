import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createSessionExecutionRegistry } from '@/modules/providers/services/session-execution.service.js';

test('chat and terminal cannot acquire aliases of one native conversation, including a newly bound id', () => {
  const ids = new Map<string, string>();
  const registry = createSessionExecutionRegistry(id => ids.get(id) ?? null);
  const chat = registry.claim({ sessionId: 'app-a', provider: 'claude', kind: 'chat', stop() {} });
  ids.set('app-a', 'native'); ids.set('app-b', 'native');
  assert.throws(() => registry.claim({ sessionId: 'app-b', provider: 'claude', kind: 'terminal', stop() {} }), /running in chat/);
  assert.equal(registry.get('app-b')?.id, chat.owner.id);
  chat.release();
  const terminal = registry.claim({ sessionId: 'app-b', provider: 'claude', kind: 'terminal', stop() {} });
  assert.throws(() => registry.claim({ sessionId: 'app-a', provider: 'claude', kind: 'chat', stop() {} }), /running in the terminal/);
  terminal.release();
});

test('takeover keeps ownership until exit, coalesces stops, and rejects a stale owner token', async () => {
  const registry = createSessionExecutionRegistry(() => null);
  let stops = 0;
  const old = registry.claim({ sessionId: 'app', provider: 'claude', kind: 'terminal', stop() { stops++; } });
  const first = registry.stop('app', old.owner.id);
  const second = registry.stop('app', old.owner.id);
  await Promise.resolve();
  assert.equal(stops, 1);
  assert.equal(registry.get('app')?.stopping, true);
  assert.throws(() => registry.claim({ sessionId: 'app', provider: 'claude', kind: 'chat', stop() {} }));
  old.release();
  await Promise.all([first, second]);
  const next = registry.claim({ sessionId: 'app', provider: 'claude', kind: 'chat', stop() { stops++; } });
  await assert.rejects(registry.stop('app', old.owner.id), /owner changed/);
  old.release();
  assert.equal(registry.get('app')?.id, next.owner.id);
  assert.equal(stops, 1);
  next.release();
});

test('failed shutdown keeps the original owner and allows a later retry', async () => {
  const registry = createSessionExecutionRegistry(() => null);
  let fail = true;
  const lease = registry.claim({ sessionId: 'app', provider: 'claude', kind: 'terminal', stop() {
    if (fail) throw new Error('stop failed');
    lease.release();
  } });
  await assert.rejects(registry.stop('app', lease.owner.id), /stop failed/);
  assert.equal(registry.get('app')?.id, lease.owner.id);
  fail = false;
  await registry.stop('app', lease.owner.id);
  assert.equal(registry.get('app'), null);
});


test('a real child retains exclusive ownership after SIGTERM until its delayed exit', { timeout: 5000 }, async () => {
  const registry = createSessionExecutionRegistry(() => null);
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => { process.stdout.write('stopping'); setTimeout(() => process.exit(0), 150); }); process.stdout.write('ready'); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = once(child, 'exit');
  const lease = registry.claim({ sessionId: 'real-process', provider: 'claude', kind: 'terminal', stop() { child.kill('SIGTERM'); } });
  child.once('exit', lease.release);
  try {
    await once(child.stdout!, 'data');
    const signalHandled = once(child.stdout!, 'data');
    const stopped = registry.stop('real-process', lease.owner.id);
    await signalHandled;
    assert.equal(child.exitCode, null);
    assert.throws(() => registry.claim({ sessionId: 'real-process', provider: 'claude', kind: 'chat', stop() {} }));
    await stopped;
    assert.equal(child.exitCode, 0);
    const next = registry.claim({ sessionId: 'real-process', provider: 'claude', kind: 'chat', stop() {} });
    next.release();
  } finally { child.kill('SIGKILL'); await exited; lease.release(); }
});

test('a changed native id retains one owner for both raw native ids and the stable app id', async () => {
  let currentNative = 'native-old';
  const registry = createSessionExecutionRegistry(id => id === 'app' ? currentNative : null);
  let stops = 0;
  const lease = registry.claim({ sessionId: 'app', nativeId: currentNative, provider: 'claude', kind: 'chat', stop() { stops++; lease.release(); } });
  currentNative = 'native-new';
  for (const id of ['app', 'native-old', 'native-new']) {
    assert.equal(registry.get(id, 'claude')?.id, lease.owner.id);
    assert.throws(() => registry.claim({ sessionId: id, provider: 'claude', kind: 'terminal', stop() {} }), /running in chat/);
  }
  await registry.stop('native-new', lease.owner.id);
  assert.equal(stops, 1);
  assert.equal(registry.get('app'), null);
});
