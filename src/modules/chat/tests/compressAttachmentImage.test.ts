import { afterEach, expect, test, vi } from 'vitest';
import { compressAttachmentImage } from '@/modules/chat/utils/compressAttachmentImage';
afterEach(() => vi.restoreAllMocks());

test('small files, documents and animated images retain their original bytes', async () => {
  for (const type of ['text/plain', 'image/gif', 'image/svg+xml', 'image/webp', 'image/png']) {
    const file = new File(['original'], 'attachment', { type });
    expect(await compressAttachmentImage(file)).toBe(file);
  }
});

test('ordinary text screenshots keep their dimensions and only use a smaller high-quality encoding', async () => {
  const bitmap = { width: 1080, height: 2400, close: vi.fn() };
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  const context = { drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['compressed'], { type: 'image/webp' })));
  const file = new File([new Uint8Array(512 * 1024)], 'screenshot.png', { type: 'image/png' });
  const compressed = await compressAttachmentImage(file);
  expect(compressed.name).toBe('screenshot.webp');
  expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1080, 2400);
  expect(encode.mock.calls[0].slice(1)).toEqual(['image/webp', 0.94]);
  expect(bitmap.close).toHaveBeenCalled();
  vi.unstubAllGlobals();
});

test('failed decoding falls back to the original attachment', async () => {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('Unsupported image'); }));
  const file = new File([new Uint8Array(512 * 1024)], 'photo.jpg', { type: 'image/jpeg' });
  expect(await compressAttachmentImage(file)).toBe(file);
  vi.unstubAllGlobals();
});
