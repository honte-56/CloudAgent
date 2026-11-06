import assert from 'node:assert/strict';
import test from 'node:test';
import { createNormalizedMessage, LEGACY_GITHUB_AUTH_INSTRUCTIONS, prependRuntimeInstructions, stripRuntimeInstructions } from '@/shared/utils.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { appendFilesInputTag } from '@/shared/image-attachments.js';

const prompt = '看看这些日志里还有哪些问题';
const file = { path: '/home/user/.cloudcli/assets/logs.jsonl', name: 'logs.jsonl', size: 160000 };
for (const envelope of ['legacy', 'tagged']) for (const array of [false, true]) test(`Claude ${envelope} context with attachment stays out of the user bubble (${array ? 'blocks' : 'string'})`, () => {
  const text = appendFilesInputTag(envelope === 'legacy' ? `${LEGACY_GITHUB_AUTH_INSTRUCTIONS}\n\n${prompt}` : prependRuntimeInstructions(LEGACY_GITHUB_AUTH_INSTRUCTIONS, prompt), [file]);
  const p = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const [row] = p.normalizeMessage({ type: 'user', uuid: 'native-user', message: { role: 'user', content: array ? [{ type: 'text', text }] : text } }, 's');
  assert.equal(row.content, prompt);
  assert(Array.isArray(row.files));
  assert.equal(row.files.length, 1);
  assert.equal(row.files[0].path, file.path);
  assert.equal(row.transcriptAnchorId, 'native-user');
  assert.equal(row.runtimeContextStripped, true);
});

test('the runtime still receives its context and the original prompt intact', () => {
  const input = prependRuntimeInstructions(LEGACY_GITHUB_AUTH_INSTRUCTIONS, '  original\ntext');
  assert(input.includes(LEGACY_GITHUB_AUTH_INSTRUCTIONS));
  assert.equal(stripRuntimeInstructions(input), '  original\ntext');
});

test('quoted, embedded, malformed and unrelated instructions remain untouched', () => {
  for (const text of [`Please explain:\n${LEGACY_GITHUB_AUTH_INSTRUCTIONS}\n\nhello`, '```\n'+prependRuntimeInstructions('context', 'example')+'\n```', '<cloudcli_runtime_context>\nmissing end', 'This project uses GitHub.\n\nhello']) assert.equal(stripRuntimeInstructions(text), text);
});

test('only user text is cleaned, and the marker prevents stripping user quotations twice', () => {
  const content = `${LEGACY_GITHUB_AUTH_INSTRUCTIONS}\n\nExplain the paragraph above`;
  for (const role of ['assistant', 'system'] as const) assert.equal(createNormalizedMessage({ kind: 'text', role, provider: 'claude', content }).content, content);
  const once = createNormalizedMessage({ kind: 'text', role: 'user', provider: 'claude', content: prependRuntimeInstructions('runtime only', content) });
  assert.equal(once.content, content);
  assert.equal(createNormalizedMessage(once).content, content);
});
