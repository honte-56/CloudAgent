import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeProviderModels, extractClaudeEventModel } from '@/modules/providers/list/claude/claude-models.provider.js';

const SESSION_ID = 'session-1';

test('ignores the <synthetic> placeholder Claude Code stamps on synthesized rows', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: '<synthetic>' } },
      SESSION_ID,
    ),
    null,
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: '<synthetic>' }, SESSION_ID),
    null,
  );
});

test('still surfaces real model ids from message and event fields', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: 'claude-sonnet-5' } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: 'opus' }, SESSION_ID),
    'opus',
  );
});

test('skips a placeholder content part so a later real model tag still wins', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: [
            { text: '<model><synthetic></model>' },
            { text: '<model>claude-sonnet-5</model>' },
          ],
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('a placeholder stdout hit does not shadow a real <model> tag in the same text', () => {
  const text = '<local-command-stdout>Set model to <synthetic></local-command-stdout>'
    + '<model>claude-sonnet-5</model>';
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: text } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: [{ text }] } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('falls back to the message model when every content hit is a placeholder', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: '<model><synthetic></model>',
          model: 'claude-sonnet-5',
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});


test('Claude choices and effort support come from the SDK, including previously unknown models', async () => {
  const adapter = new ClaudeProviderModels(async () => [
    { value: 'future-alias', displayName: 'Future model', description: 'Native label', supportedEffortLevels: ['low', 'xhigh'] },
    { value: 'default', displayName: 'Account default', description: 'Native default', supportsEffort: false, supportedEffortLevels: ['high'] },
  ]);
  const result = await adapter.getSupportedModels();
  assert.equal(result.DEFAULT, 'default');
  assert.deepEqual(result.OPTIONS.map((option) => option.value), ['future-alias', 'default']);
  assert.equal(result.OPTIONS[0].label, 'Future model');
  assert.deepEqual(result.OPTIONS[0].effort?.values.map((level) => level.value), ['low', 'xhigh', 'ultracode']);
  assert.equal(result.OPTIONS[1].effort, undefined);
  assert.equal(result.OPTIONS[0].effort?.default, undefined);
});

test('Claude discovery errors propagate and no fixed choices are added to an empty list', async () => {
  await assert.rejects(new ClaudeProviderModels(async () => { throw new Error('offline'); }).getSupportedModels(), /offline/);
  assert.deepEqual(await new ClaudeProviderModels(async () => []).getSupportedModels(), { OPTIONS: [], DEFAULT: '' });
});
