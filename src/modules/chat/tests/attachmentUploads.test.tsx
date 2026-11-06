import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useAttachmentUploads } from '@/modules/chat/hooks/useAttachmentUploads';
import ComposerAttachment from '@/modules/chat/composer/ComposerAttachment';

const transport = vi.hoisted(() => ({ uploadAttachment: vi.fn(), cancelUpload: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/shared/api', () => ({ api: { assets: transport } }));
vi.mock('@/modules/chat/transcript/ChatMessageImages', () => ({ ImageLightbox: () => null }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('selection starts uploading before submit, shows byte progress, and sending reuses the upload', async () => {
  let finish!: (descriptor: unknown) => void;
  let progress!: (value: number) => void;
  transport.uploadAttachment.mockImplementation((_file, _id, _signal, onProgress) => { progress = onProgress; return new Promise(resolve => { finish = resolve; }); });
  const file = new File(['test'], 'document.txt');
  const cache = new WeakMap<File, unknown>();
  const files = [file];
  const view = renderHook(() => useAttachmentUploads(files, cache));
  await waitFor(() => expect(transport.uploadAttachment).toHaveBeenCalledTimes(1));
  act(() => progress(42));
  expect(view.result.current.states.get(file)?.progress).toBe(42);
  let sending!: Promise<unknown[]>;
  act(() => { sending = view.result.current.ready(files); });
  expect(transport.uploadAttachment).toHaveBeenCalledTimes(1);
  const descriptor = { path: '/uploaded/document.txt', name: file.name };
  await act(async () => { finish(descriptor); await sending; });
  expect(view.result.current.states.get(file)?.status).toBe('ready');
  expect(await view.result.current.ready(files)).toEqual([descriptor]);
  expect(transport.uploadAttachment).toHaveBeenCalledTimes(1);
});

test('cancel aborts the transfer and deletes its server upload even before the final response', async () => {
  let signal!: AbortSignal;
  transport.uploadAttachment.mockImplementation((_file, _id, value) => {
    signal = value;
    return new Promise((_resolve, reject) => value.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError'))));
  });
  const file = new File(['test'], 'document.txt');
  const cache = new WeakMap<File, unknown>();
  const files = [file];
  const view = renderHook(() => useAttachmentUploads(files, cache));
  await waitFor(() => expect(transport.uploadAttachment).toHaveBeenCalledTimes(1));
  await act(async () => { await view.result.current.cancel(file); });
  expect(signal.aborted).toBe(true);
  expect(transport.cancelUpload).toHaveBeenCalledWith(transport.uploadAttachment.mock.calls[0][1]);
  expect(cache.has(file)).toBe(false);
});

test('attachment overlay reports progress and disappears when ready; removal remains available', () => {
  const file = new File(['test'], 'document.txt');
  const remove = vi.fn();
  const view = render(<ComposerAttachment file={file} onRemove={remove} uploadState={{ status: 'uploading', progress: 42 }} />);
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
  expect(screen.getByRole('button', { name: 'Remove document.txt' })).toBeTruthy();
  view.rerender(<ComposerAttachment file={file} onRemove={remove} uploadState={{ status: 'ready', progress: 100 }} />);
  expect(screen.queryByRole('progressbar')).toBeNull();
});


test('sending after the unsent lease has expired reuploads the original local file', async () => {
  transport.uploadAttachment.mockImplementation(async (_file, id) => ({ path: `/uploaded/${id}.txt` }));
  const file = new File(['test'], 'document.txt');
  const files = [file];
  const cache = new WeakMap<File, unknown>();
  const view = renderHook(() => useAttachmentUploads(files, cache));
  await waitFor(() => expect(view.result.current.states.get(file)?.status).toBe('ready'));
  const first = cache.get(file);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_001);
  try {
    let sent!: unknown[];
    await act(async () => { sent = await view.result.current.ready(files); });
    expect(transport.uploadAttachment).toHaveBeenCalledTimes(2);
    expect(sent[0]).not.toEqual(first);
  } finally { clock.mockRestore(); }
});
