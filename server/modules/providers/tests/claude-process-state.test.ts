import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createClaudeProcessStateObserver } from '@/modules/providers/list/claude/claude-process-state.provider.js';

test('observes hidden CLI idle states without changing stdout or accepting oversized/tool frames', async () => {
  const frames = [
    JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'running', sdk_host_only: true }),
    JSON.stringify({ type: 'assistant', text: 'session_state_changed', state: 'idle' }),
    JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle', oversized: 'x'.repeat(20_000) }),
    '{invalid session_state_changed',
    JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'requires_action' }),
    JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle', sdk_host_only: true }),
  ].join('\n') + '\n';
  const states: string[] = [];
  const child = createClaudeProcessStateObserver(state => states.push(state))({
    command: process.execPath,
    args: ['-e', `const s=${JSON.stringify(frames)}; process.stdout.write(s.slice(0,25)); setTimeout(()=>process.stdout.write(s.slice(25)),10);`],
    env: process.env, signal: new AbortController().signal,
  });
  const exited = once(child, 'exit');
  let output = '';
  for await (const chunk of child.stdout) output += chunk;
  await exited;
  assert.equal(output, frames);
  assert.deepEqual(states, ['running', 'requires_action', 'idle']);
});
