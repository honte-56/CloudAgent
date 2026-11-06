import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

// CLI 2.1.316 displays these thinking blocks as public progress replies.
const progress = {
  type: 'assistant', uuid: 'progress-reply', timestamp: '2026-10-31T18:49:56.362Z',
  thinkingDisplay: 'updates',
  message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '第 1 步修复已在本地提交，接下来先写真实浏览器回归测试，通过后再发布。' }] },
};

for (const mode of ['updates', 'summarized', undefined]) {
  test(`normalization preserves CLI thinking display semantics: ${mode ?? 'ordinary'}`, () => {
    const [message] = new ClaudeSessionsProvider().normalizeMessage({ ...progress, thinkingDisplay: mode }, 'app-id');
    assert.equal(message.kind, mode === 'updates' ? 'text' : 'thinking');
    assert.equal(message.content, progress.message.content[0].thinking);
    assert.equal(message.id, 'progress-reply_0');
    if (mode === 'updates') {
      assert.equal(message.role, 'assistant');
      assert.equal(message.model, 'claude-opus-5-5');
    }
  });
}

test('historical progress replies remain visible beside ordinary replies', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-progress-display-'));
  try {
    const jsonlPath = path.join(dir, 'native-session.jsonl');
    await writeFile(jsonlPath, [progress, {
      type: 'assistant', uuid: 'ordinary-reply', timestamp: '2026-10-31T18:52:13.775Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '新测试全部通过。' }] },
    }].map(row => JSON.stringify({ ...row, sessionId: 'native-session' })).join('\n') + '\n');
    t.mock.method(sessionsDb, 'getSessionById', () => ({ jsonl_path: jsonlPath }) as never);
    const history = await new ClaudeSessionsProvider({ getLiveRunStartTime: () => null }).fetchHistory('app-id', { providerSessionId: 'native-session' });
    assert.equal(history.messages.length, 2);
    assert.deepEqual(history.messages.map(message => message.kind), ['text', 'text']);
    assert.equal(history.messages[0].content, progress.message.content[0].thinking);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
