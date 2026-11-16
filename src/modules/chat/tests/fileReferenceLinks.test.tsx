import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

/**
 * Regression guard: what a file reference in a chat message hands to the
 * editor. Both suffix helpers are anchored at the end of the string, so a
 * reference picked up from the link text — which, unlike the href, keeps the
 * whitespace around it — used to reach the API with `:12 ` still attached and
 * answer a 404.
 */

const openFileInEditor = vi.fn();
const openDirectory = vi.fn();

vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ openFileInEditor, openDirectory }),
}));

const { Markdown } = await import('@/modules/chat/transcript/Markdown');

const clickReference = (markdown: string, linkText: string) => {
  openFileInEditor.mockReset();
  openDirectory.mockReset();
  render(<Markdown>{markdown}</Markdown>);
  fireEvent.click(screen.getByText(linkText));
};

test('a `path:line` reference opens the path without its suffix, at that line', () => {
  clickReference('See [src/foo.ts:130](src/foo.ts:130).', 'src/foo.ts:130');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', 130]);
});

test('whitespace around a reference taken from the link text is dropped', () => {
  clickReference('See [`src/foo.ts:12` ]().', 'src/foo.ts:12');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', 12]);
});

test('a directory reference goes to the file tree, not the editor', () => {
  clickReference('See [decisions/](decisions/).', 'decisions/');
  assert.equal(openFileInEditor.mock.calls.length, 0);
  assert.deepEqual(openDirectory.mock.calls[0], ['decisions/']);
});

test('a plain file reference opens with no line', () => {
  clickReference('See [src/foo.ts](src/foo.ts).', 'src/foo.ts');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', null]);
});

test.each([
  ['/srv/workspace/录音/带时间戳文字稿.md', '/srv/workspace/录音/带时间戳文字稿.md'],
  ['reports/%E5%AD%97%E5%B9%95.srt', 'reports/字幕.srt'],
  ['<reports/待复核 片段.md>', 'reports/待复核 片段.md'],
  ['reports/review%20notes.md', 'reports/review notes.md'],
  ['reports/a%23b%3Fc%25.txt', 'reports/a#b?c%.txt'],
  ['reports/literal%2520.txt', 'reports/literal%20.txt'],
  ['reports/invalid%E4.txt', 'reports/invalid%E4.txt'],
])('a markdown file URL %s opens its filesystem path', (href, path) => {
  clickReference(`[打开文件](${href})`, '打开文件');
  assert.deepEqual(openFileInEditor.mock.calls, [[path, null]]);
});

test('a Chinese file URL preserves line and column navigation', () => {
  clickReference('[查看文字稿](reports/文字稿.md:12:3)', '查看文字稿');
  assert.deepEqual(openFileInEditor.mock.calls, [['reports/文字稿.md', 12]]);
});

test('a Chinese directory URL opens the decoded directory', () => {
  clickReference('[打开目录](reports/文字稿/)', '打开目录');
  assert.equal(openFileInEditor.mock.calls.length, 0);
  assert.deepEqual(openDirectory.mock.calls, [['reports/文字稿/']]);
});

test('a reference taken from link text keeps literal percent sequences', () => {
  clickReference('[reports/literal%20.txt]()', 'reports/literal%20.txt');
  assert.deepEqual(openFileInEditor.mock.calls, [['reports/literal%20.txt', null]]);
});

test('external URLs keep normal navigation and their URL encoding', () => {
  render(<Markdown>{'[外部文件](https://example.com/%E5%AD%97%E5%B9%95.srt)'}</Markdown>);
  const link = screen.getByRole('link', { name: '外部文件' });
  assert.equal(link.getAttribute('href'), 'https://example.com/%E5%AD%97%E5%B9%95.srt');
  assert.equal(link.getAttribute('target'), '_blank');
});
