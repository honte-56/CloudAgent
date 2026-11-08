import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { PaletteOpsProvider, usePaletteOpsRegister } from '@/modules/command-palette';
import { Markdown } from '@/modules/chat/transcript/Markdown';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import MarkdownFileCard from '@/modules/chat/transcript/MarkdownFileCard';
import {
  looksLikeFileReference,
  resetWorkspaceFileLookups,
} from '@/modules/chat/utils/workspaceFileReference';

const statFiles = vi.fn();
const readFileBlob = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    statFiles: (...args: unknown[]) => statFiles(...args),
    readFileBlob: (...args: unknown[]) => readFileBlob(...args),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options?.name ? `${key}:${options.name}` : key),
  }),
}));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('looksLikeFileReference', () => {
  it('accepts absolute and relative paths and common deliverable file names', () => {
    for (const text of [
      '/home/codexweb/lvxing-welcome/welcome.html',
      './out/report.pdf',
      'src/app.ts',
      'welcome.html',
      'data.csv',
    ]) {
      assert.equal(looksLikeFileReference(text), true, text);
    }
  });

  it('rejects code, urls, endpoints and dotted identifiers', () => {
    for (const text of [
      'asktable.send_question',
      'user.name',
      'POST /v1/conversations',
      'https://example.com/a.html',
      'onConversationCreated(id)',
      '/v1/conversations',
      'src/',
      '',
    ]) {
      assert.equal(looksLikeFileReference(text), false, text);
    }
  });
});

describe('MarkdownFileCard', () => {
  beforeEach(() => {
    resetWorkspaceFileLookups();
  });
  afterEach(() => {
    statFiles.mockReset();
    readFileBlob.mockReset();
    vi.restoreAllMocks();
  });

  const fallback = <code>FALLBACK</code>;

  it('keeps the plain code while unknown and when the file does not exist', async () => {
    statFiles.mockResolvedValue(json({ files: [{ path: '/x/missing.html', exists: false }] }));

    render(<MarkdownFileCard projectId="p1" filePath="/x/missing.html" fallback={fallback} />);

    assert.ok(screen.getByText('FALLBACK'));
    await waitFor(() => assert.equal(statFiles.mock.calls.length, 1));
    assert.ok(screen.getByText('FALLBACK'));
    assert.equal(screen.queryByRole('button'), null);
  });

  it('turns an existing file into a card whose button downloads it under its own name', async () => {
    statFiles.mockResolvedValue(json({
      files: [{ path: '/home/u/welcome.html', exists: true, name: 'welcome.html', size: 2048, mimeType: 'text/html' }],
    }));
    readFileBlob.mockResolvedValue(new Response('<h1>hi</h1>', { status: 200 }));
    const createObjectURL = vi.fn(() => 'blob:fake');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
      clicks.push(this.download);
    });

    render(<MarkdownFileCard projectId="p1" filePath="/home/u/welcome.html" fallback={fallback} />);

    await waitFor(() => assert.ok(screen.getByText('welcome.html')));
    assert.equal(screen.queryByText('FALLBACK'), null);
    assert.ok(screen.getByText('2.0 KB'));

    fireEvent.click(screen.getByRole('button', { name: 'fileCard.download:welcome.html' }));

    await waitFor(() => assert.deepEqual(clicks, ['welcome.html']));
    assert.deepEqual(readFileBlob.mock.calls[0].slice(0, 2), ['p1', '/home/u/welcome.html']);
  });

  it('offers the shared viewer for unsupported files, and asks the server once per path', async () => {
    statFiles.mockResolvedValue(json({
      files: [{ path: 'out/archive.zip', exists: true, name: 'archive.zip', size: 10 }],
    }));

    const first = render(<MarkdownFileCard projectId="p1" filePath="out/archive.zip" fallback={fallback} />);
    await waitFor(() => assert.ok(screen.getByText('archive.zip')));
    first.unmount();
    render(<MarkdownFileCard projectId="p1" filePath="out/archive.zip" fallback={fallback} />);
    await waitFor(() => assert.ok(screen.getByText('archive.zip')));

    assert.ok(screen.getByRole('button', { name: /fileCard.preview/ }));
    assert.equal(statFiles.mock.calls.length, 1);
  });

  it.each(['notes.md', 'welcome.html', 'shot.png', 'doc.pdf', 'archive.zip', 'clip.mp4', 'large.json'])(
    'opens inline %s references through the workspace viewer without a local preview',
    async (name) => {
      const filePath = `/home/u/${name}`;
      statFiles.mockResolvedValue(json({ files: [{ path: filePath, exists: true, name, size: 3 * 1024 * 1024 }] }));
      const openFileInEditor = vi.fn();
      const openFile = vi.fn();
      function Transcript() {
        usePaletteOpsRegister({ openFileInEditor, openFile });
        return (
          <MarkdownWorkspaceContext.Provider value={{ projectId: 'p1' }}>
            <Markdown>{`文档已写好，放在 \`${filePath}\`。`}</Markdown>
          </MarkdownWorkspaceContext.Provider>
        );
      }

      render(<PaletteOpsProvider><Transcript /></PaletteOpsProvider>);
      fireEvent.click(await screen.findByRole('button', { name: `fileCard.preview:${name}` }));
      assert.deepEqual(openFileInEditor.mock.calls, [[filePath, undefined]]);
      fireEvent.click(screen.getByRole('button', { name }));
      assert.equal(openFileInEditor.mock.calls.length, 2);
      assert.equal(openFile.mock.calls.length, 0);
      assert.equal(readFileBlob.mock.calls.length, 0);
      assert.equal(screen.queryByRole('dialog'), null);
      assert.equal(document.querySelector('iframe, pre'), null);
    },
  );
});
