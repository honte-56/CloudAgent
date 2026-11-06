/** Composer uploads use conservative browser compression; animated/vector formats and small images keep their originals. */
export async function compressAttachmentImage(file: File): Promise<File> {
  if (!['image/jpeg', 'image/png'].includes(file.type) || file.size < 256 * 1024 || typeof createImageBitmap !== 'function') return file;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    // Preserve ordinary screenshot dimensions; only very large images scale
    // down. PNG text screenshots use higher quality than photographs.
    const scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height), Math.sqrt(10_000_000 / (bitmap.width * bitmap.height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', file.type === 'image/png' ? 0.94 : 0.86));
    if (!blob || blob.type !== 'image/webp' || blob.size >= file.size * 0.85) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: blob.type, lastModified: file.lastModified });
  } catch { return file; }
  finally { bitmap?.close(); }
}
