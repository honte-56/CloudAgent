import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/shared/api';
import { compressAttachmentImage } from '@/modules/chat/utils/compressAttachmentImage';
import type { AttachmentUploadState } from '@/shared/types';

type Upload = { id: string; controller: AbortController; promise: Promise<unknown>; cancelled: boolean; failed?: boolean; completedAt?: number };

/** Composer selection starts uploads immediately; sends await the same promises and reuse successful descriptors. */
export function useAttachmentUploads(files: File[], cache: WeakMap<File, unknown>) {
  const uploadsRef = useRef(new Map<File, Upload>());
  const mountedRef = useRef(true);
  // Serialize image decoding to avoid several full-resolution canvases exhausting mobile memory.
  const compressionRef = useRef<Promise<void>>(Promise.resolve());
  // Progress belongs to File identities, so duplicate filenames remain independent.
  const [states, setStates] = useState<Map<File, AttachmentUploadState>>(new Map());
  const update = useCallback((file: File, state: AttachmentUploadState) => {
    if (mountedRef.current) setStates(previous => new Map(previous).set(file, state));
  }, []);
  const ensure = useCallback((file: File): Promise<unknown> => {
    let existing = uploadsRef.current.get(file);
    // A still-open composer can outlive the server's one-hour unsent lease.
    // Re-upload the local File before sending instead of reusing an expired path.
    if (existing?.completedAt && Date.now() - existing.completedAt >= 59 * 60_000) {
      cache.delete(file); uploadsRef.current.delete(file); existing = undefined;
    }
    if (cache.has(file)) return Promise.resolve(cache.get(file));
    if (existing && !existing.failed) return existing.promise;
    const upload: Upload = { id: existing?.id ?? crypto.randomUUID(), controller: new AbortController(), cancelled: false, promise: Promise.resolve() };
    uploadsRef.current.set(file, upload);
    update(file, { status: 'compressing', progress: 0 });
    upload.promise = (async () => {
      try {
        const compression = compressionRef.current.then(() => {
          if (upload.cancelled) throw new DOMException('Upload cancelled', 'AbortError');
          return compressAttachmentImage(file);
        });
        compressionRef.current = compression.then(() => {}, () => {});
        const compressed = await compression;
        if (upload.cancelled) throw new DOMException('Upload cancelled', 'AbortError');
        update(file, { status: 'uploading', progress: 0 });
        const descriptor = await api.assets.uploadAttachment(compressed, upload.id, upload.controller.signal,
          progress => { if (!upload.cancelled) update(file, { status: 'uploading', progress }); });
        if (upload.cancelled) throw new DOMException('Upload cancelled', 'AbortError');
        upload.completedAt = Date.now();
        cache.set(file, descriptor);
        update(file, { status: 'ready', progress: 100 });
        return descriptor;
      } catch (error) {
        upload.failed = true;
        if (!upload.cancelled) update(file, { status: 'error', progress: 0, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    })();
    void upload.promise.catch(() => {}); // Selection is fire-and-forget; send explicitly awaits failures.
    return upload.promise;
  }, [cache, update]);
  const cancel = useCallback(async (file: File) => {
    const upload = uploadsRef.current.get(file);
    if (!upload) return;
    upload.cancelled = true;
    upload.controller.abort();
    cache.delete(file);
    const response = await api.assets.cancelUpload(upload.id);
    if (!response.ok) throw new Error('服务器附件删除失败，请检查连接后重试。');
    uploadsRef.current.delete(file);
    if (mountedRef.current) setStates(previous => { const next = new Map(previous); next.delete(file); return next; });
  }, [cache]);
  useEffect(() => {
    for (const file of files) void ensure(file).catch(() => {});
  }, [files, ensure]);
  useEffect(() => {
    mountedRef.current = true;
    const uploads = uploadsRef.current;
    return () => {
      mountedRef.current = false;
      setTimeout(() => {
        if (!mountedRef.current) for (const upload of uploads.values()) { upload.cancelled = true; upload.controller.abort(); }
      }, 0);
      // Completed, unsent files are reclaimed by the server's one-hour lease.
    };
  }, []);
  // Checked synchronously before admitting a send, including keyboard submits.
  const isReady = useCallback((selected: File[]) => selected.every(file => {
    const upload = uploadsRef.current.get(file);
    const fresh = !upload?.cancelled && cache.has(file) && (!upload?.completedAt || Date.now() - upload.completedAt < 59 * 60_000);
    if (!fresh && upload?.completedAt) void ensure(file).catch(() => {});
    return fresh;
  }), [cache, ensure]);
  const retry = useCallback((file: File) => { void ensure(file).catch(() => {}); }, [ensure]);
  const ready = useCallback(async (selected: File[]) => {
    const descriptors: unknown[] = [];
    for (const file of selected) descriptors.push(await ensure(file));
    return descriptors;
  }, [ensure]);
  const forget = useCallback((sentFiles: File[]) => {
    for (const file of sentFiles) uploadsRef.current.delete(file);
    setStates(previous => { const next = new Map(previous); for (const file of sentFiles) next.delete(file); return next; });
  }, []);
  return { states, ready, isReady, retry, cancel, forget };
}
