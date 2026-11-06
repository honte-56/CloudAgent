import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

const mock = vi.hoisted(() => ({ read: vi.fn(), blob: vi.fn(), stat: vi.fn(), save: vi.fn(), copy: vi.fn(), urls: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { readFile: mock.read, readFileBlob: mock.blob, statFiles: mock.stat, saveFile: mock.save }, readApiJson: async (response: Response) => {
  if (!response.ok) throw new Error('File not found');
  return response.json();
} }));
vi.mock('@/shared/utils', async (original) => ({ ...await original<object>(), copyTextToClipboard: mock.copy }));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('@uiw/react-codemirror', () => ({ default: ({ value, onChange }: { value: string; onChange: (s: string) => void }) => <textarea aria-label="Source" value={value} onChange={e => onChange(e.target.value)} /> }));
const { default: CodeEditor } = await import('@/modules/code-editor/CodeEditor');
const { FileViewerRoute } = await import('@/modules/code-editor/FileViewerRoute');
const file = { name: '资料 #1.zip', path: '/repo/资料 #1.zip', projectId: 'p1' };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  mock.read.mockReset().mockResolvedValue(json({ content: '<h1>Report</h1>' }));
  mock.stat.mockReset().mockResolvedValue(json({ files: [{ exists: true, size: 5432100 }] }));
  mock.blob.mockReset().mockImplementation(async () => new Response(new Uint8Array([80,75,3,4,0,255,128]), { headers: { 'Content-Type': 'application/zip' } }));
  mock.copy.mockReset().mockResolvedValue(true);
  mock.save.mockReset();
  mock.urls.mockReset().mockReturnValue('blob:test');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: mock.urls });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
function open(name = file.name) {
  return render(<MemoryRouter initialEntries={['/session/abc']}><CodeEditor file={{ ...file, name, path: `/repo/${name}` }} isSidebar onClose={() => {}} /></MemoryRouter>);
}

test('unsupported files retain download/path/link actions and download exact original bytes', async () => {
  open();
  expect(await screen.findByText('5.2 MB', { exact: false })).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: 'Download file' })[0]);
  await waitFor(() => expect(mock.urls).toHaveBeenCalledTimes(1));
  const buffer = await new Promise<ArrayBuffer>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.readAsArrayBuffer(mock.urls.mock.calls[0][0]); });
  const bytes = new Uint8Array(buffer);
  expect(Array.from(bytes)).toEqual([80,75,3,4,0,255,128]);
  expect(mock.read).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });
  expect(mock.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Copy file path' }));
  await waitFor(() => expect(mock.copy).toHaveBeenCalledWith(file.path));
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy file link' }));
  await waitFor(() => expect(mock.copy).toHaveBeenCalledTimes(2));
  const url = new URL(mock.copy.mock.calls[1][0]);
  expect(url.pathname).toBe('/file');
  expect(url.searchParams.get('path')).toBe(file.path);
  expect(url.searchParams.get('projectId')).toBe('p1');
  expect(url.searchParams.has('token')).toBe(false);
});

test('download errors leave actions available and retry fetches the original file', async () => {
  mock.blob.mockResolvedValueOnce(new Response('missing', { status: 404 }));
  open();
  fireEvent.click(screen.getAllByRole('button', { name: 'Download file' })[0]);
  await screen.findByText('Download failed (404)');
  expect(mock.urls).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole('button', { name: 'Download file' })[0]);
  await waitFor(() => expect(mock.urls).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('Download failed (404)')).toBeNull();
});

test('HTML eye switches in place and back without dropping edits, with sandboxed new-tab preview', async () => {
  open('report.html');
  const source = await screen.findByRole('textbox', { name: 'Source' });
  fireEvent.change(source, { target: { value: '<h1>Edited</h1>' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  const frame = document.querySelector('iframe[title="report.html"]')!;
  expect(frame.getAttribute('srcdoc')).toBe('<h1>Edited</h1>');
  expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  expect(screen.getByRole('button', { name: 'Download file' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  const previewDocument = document.implementation.createHTMLDocument();
  const popup = { opener: window, document: previewDocument };
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open preview in new tab' }));
  expect(previewDocument.querySelector('iframe')?.getAttribute('srcdoc')).toBe('<h1>Edited</h1>');
  expect(popup.opener).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit source' }));
  expect((screen.getByRole('textbox', { name: 'Source' }) as HTMLTextAreaElement).value).toBe('<h1>Edited</h1>');
});

test('Markdown retains its eye toggle and common actions in preview', async () => {
  mock.read.mockResolvedValue(json({ content: '# A markdown report' }));
  open('report.md');
  await screen.findByRole('textbox', { name: 'Source' });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByRole('heading', { name: 'A markdown report' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Download file' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Edit source' }));
  expect(screen.getByRole('textbox', { name: 'Source' })).toBeTruthy();
});

test('media and text read failures preserve common actions and cannot overwrite files', async () => {
  mock.blob.mockRejectedValueOnce(new Error('offline'));
  const view = open('photo.png');
  await screen.findByText('Unable to display this file.');
  expect(screen.getByRole('button', { name: 'Download file' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  expect(screen.getByRole('menuitem', { name: 'Copy file link' })).toBeTruthy();
  view.unmount();
  mock.read.mockResolvedValueOnce(new Response('', { status: 404 }));
  open('missing.txt');
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Download file' })).toBeTruthy();
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });
  expect(mock.save).not.toHaveBeenCalled();
});

test('copied file route reopens a file without a selected project or session', async () => {
  render(<MemoryRouter basename="/cloud" initialEntries={[`/cloud/file?${new URLSearchParams({ projectId: 'p1', path: file.path })}`]}><Routes><Route path="/file" element={<FileViewerRoute />} /></Routes></MemoryRouter>);
  await screen.findByText('5.2 MB', { exact: false });
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy file link' }));
  await waitFor(() => expect(mock.copy).toHaveBeenCalledTimes(1));
  expect(new URL(mock.copy.mock.calls[0][0]).pathname).toBe('/cloud/file');
});

test('switching files cancels old downloads before they can save under the wrong filename', async () => {
  let resolve!: (response: Response) => void;
  mock.blob.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
  const view = open();
  fireEvent.click(screen.getAllByRole('button', { name: 'Download file' })[0]);
  const signal = mock.blob.mock.calls[0][2].signal as AbortSignal;
  view.rerender(<MemoryRouter><CodeEditor file={{ ...file, name: 'other.zip', path: '/repo/other.zip' }} isSidebar onClose={() => {}} /></MemoryRouter>);
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(new Response('old bytes')));
  expect(mock.urls).not.toHaveBeenCalled();
});
