import { retainAttachmentUploads } from '@/modules/assets/index.js';
import { createHash } from 'node:crypto';
import { sessionsDb, sessionDraftsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionExecutionService } from '@/modules/providers/services/session-execution.service.js';
import { AppError, filterAttachmentsToUploadStore } from '@/shared/index.js';

function resolve(sessionId: string, mutation = false) {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) throw new AppError('Session not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
  if (mutation && sessionExecutionService.get(sessionId)?.kind === 'terminal') {
    throw new AppError('Take over this conversation in chat before changing its queue.', { code: 'SESSION_OWNED', statusCode: 409 });
  }
  const queue = providerRegistry.resolveProvider(session.provider).runtime.queue;
  if (!queue) throw new AppError('This provider does not expose a native input queue.', { code: 'QUEUE_UNSUPPORTED', statusCode: 409 });
  return { queue, nativeId: session.provider_session_id };
}

/** Used by provider routes; entries are held by the CLI, not by the browser draft slot. */
export const nativeMessageQueueService = {
  async list(sessionId: string) {
    const { queue, nativeId } = resolve(sessionId);
    return queue.list(sessionId, nativeId);
  },
  async add(sessionId: string, content: string, attachments: unknown[], requestId: string, userId: number) {
    const { queue } = resolve(sessionId, true);
    const verified = filterAttachmentsToUploadStore(attachments);
    if (verified.length !== attachments.length) throw new AppError('Invalid attachment.', { code: 'INVALID_ATTACHMENT', statusCode: 400 });
    // Preserve the ordering of a pre-update single-slot draft. Claim it with
    // the same compare-and-swap used by the old dispatcher before migrating.
    const legacy = sessionDraftsDb.listQueuedMessages().find(entry => entry.userId === userId && entry.sessionId === sessionId);
    const pending = legacy?.queuedMessage as { content?: string; attachments?: unknown[]; deliveryError?: string } | undefined;
    if (legacy && typeof pending?.content === 'string' && !pending.deliveryError && sessionDraftsDb.claimQueuedMessage(legacy)) {
      try {
        const hash = createHash('sha256').update(`${userId}:${sessionId}:${legacy.claimToken}`).digest('hex');
        const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        const files = filterAttachmentsToUploadStore(pending.attachments ?? []);
        await retainAttachmentUploads(files, userId);
        await queue.add(sessionId, pending.content, files, id);
        sessionDraftsDb.deleteEmptyDraft(userId, sessionId);
      } catch (error) {
        sessionDraftsDb.restoreQueuedMessage({ ...legacy, claimToken: JSON.stringify({ ...pending,
          deliveryError: error instanceof Error ? error.message : String(error) }) });
        throw error;
      }
    }
    await retainAttachmentUploads(verified, userId);
    return queue.add(sessionId, content, verified, requestId);
  },
  async cancel(sessionId: string, id: string) {
    const { queue, nativeId } = resolve(sessionId, true);
    return queue.cancel(sessionId, id, nativeId);
  },
  async sendNow(sessionId: string, id: string) {
    return resolve(sessionId, true).queue.sendNow(sessionId, id);
  },
};
