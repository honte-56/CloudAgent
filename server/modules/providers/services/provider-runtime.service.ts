import { retainAttachmentUploads } from '@/modules/assets/index.js';
import { resolveProjectGithubAuthentication } from '@/modules/github-auth/index.js';
import { isDeepStrictEqual } from 'node:util';
import { sessionsDb, sessionDraftsDb } from '@/modules/database/index.js';
import { AppError, filterAttachmentsToUploadStore, prependRuntimeInstructions } from '@/shared/utils.js';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { sessionExecutionService } from '@/modules/providers/services/session-execution.service.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRunFunction,
  ProviderRunReservation,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

type ProviderRuntimeServiceDependencies = {
  execution: typeof sessionExecutionService;
  listProviders(): IProvider[];
  resolveProvider(provider: string): IProvider;
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels: typeof providerModelsService.getProviderModels;
  startResumedTurn(sessionId: string, content: string, attachments: unknown[], userId: number | null): Promise<void>;
};

const defaultDependencies: ProviderRuntimeServiceDependencies = {
  execution: sessionExecutionService,
  listProviders: () => providerRegistry.listProviders(),
  resolveProvider: (provider) => providerRegistry.resolveProvider(provider),
  resolveProviderSessionId: (sessionId) => sessionsService.resolveProviderSessionId(sessionId),
  resolveResumeModel: (provider, sessionId, requestedModel) =>
    providerModelsService.resolveResumeModel(provider, sessionId, requestedModel),
  getProviderModels: (provider) => providerModelsService.getProviderModels(provider),
  async startResumedTurn(sessionId, content, attachments, userId): Promise<void> {
    const { startDetachedChatTurn } = await import('@/modules/websocket/index.js');
    await startDetachedChatTurn({ sessionId, content, userId, options: { attachments } }, { runtime: providerRuntimeService });
  },
};

/**
 * Creates the application-facing provider runtime dispatcher.
 *
 * The provider registry owns each concrete runtime. This service supplies the
 * registry-backed model/session lookups at execution time so runtime adapters
 * never import services that resolve back through the registry.
 */
export function createProviderRuntimeService(
  dependencyOverrides: Partial<ProviderRuntimeServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  const createRuntimeContext = (
    provider: IProvider,
  ): ProviderRuntimeContext => ({
    resolveProviderSessionId: dependencies.resolveProviderSessionId,
    resolveResumeModel: (sessionId, requestedModel) =>
      dependencies.resolveResumeModel(provider.id, sessionId, requestedModel),
    getProviderModels: async () => dependencies.getProviderModels(provider.id),
    normalizeMessage: (raw, sessionId) => provider.sessions.normalizeMessage(raw, sessionId),
    async isProviderInstalled() {
      try {
        return (await provider.auth.getStatus()).installed;
      } catch {
        // Preserve the runtime's original error when installation probing fails.
        return true;
      }
    },
  });

  const execute = async (
    providerName: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
    beforeLaunch: () => void,
  ): Promise<unknown> => {
    const provider = dependencies.resolveProvider(providerName);
    // Runtime environments come from the server, never from chat/API options.
    const { environment: _untrustedEnvironment, ...runtimeOptions } = options;
    const authentication = writer.userId && (options.cwd || options.projectPath)
      ? await resolveProjectGithubAuthentication(Number(writer.userId), options.cwd || options.projectPath)
      : null;
    // App session IDs exist before the first turn; only a native session ID means resume.
    const includeAuthenticationInstructions = authentication
      && !dependencies.resolveProviderSessionId(options.sessionId);
    beforeLaunch();
    return provider.runtime.run(
      includeAuthenticationInstructions ? prependRuntimeInstructions(authentication.instructions, command) : command,
      authentication ? { ...runtimeOptions, environment: authentication.environment } : runtimeOptions,
      writer, createRuntimeContext(provider),
    );
  };

  const reserveRun = (providerName: LLMProvider, sessionId: string): ProviderRunReservation => {
    let cancelled = false;
    let started = false;
    let consumed = false;
    const lease = dependencies.execution.claim({
      sessionId, provider: providerName, kind: 'chat',
      nativeId: dependencies.resolveProviderSessionId(sessionId),
      async stop() {
        cancelled = true;
        if (started) await dependencies.resolveProvider(providerName).runtime.abort(sessionId);
        else lease.release();
      },
    });
    return {
      release() { if (!started) { cancelled = true; lease.release(); } },
      async run(command, options, writer) {
        if (consumed) throw new Error('Execution reservation was already used.');
        consumed = true;
        try {
          return await execute(providerName, command, options, writer, () => {
            if (cancelled) throw new Error('Session ownership was transferred before startup. Your message was not sent.');
            started = true;
          });
        } finally { lease.release(); }
      },
    };
  };

  const run = async (provider: LLMProvider, command: string, options: AnyRecord, writer: ProviderRuntimeWriter) => {
    // Unbound tools create a new conversation; all resumable chat/SSE runs have
    // an app session id and must reserve it before async authentication work.
    if (!options.sessionId) return execute(provider, command, options, writer, () => {});
    return reserveRun(provider, options.sessionId).run(command, options, writer);
  };

  return {
    run,
    reserveRun,
    getExecutionOwner: (sessionId: string) => dependencies.execution.get(sessionId),

    /** Used by Providers' authenticated HTTP route to confirm delivery to an active turn. */
    async steer(sessionId: string, content: string, attachments: unknown[] = [], queuedUserId?: number, requestingUserId?: number): Promise<void> {
      const session = sessionsDb.getSessionById(sessionId);
      if (!session) throw new AppError('Session not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
      if (dependencies.execution.get(sessionId)?.kind === 'terminal') {
        throw new AppError('This conversation is running in the terminal. Take over in chat first; your message is kept.', { code: 'SESSION_OWNED', statusCode: 409 });
      }
      const runtime = dependencies.resolveProvider(session.provider).runtime;
      if (!runtime.steer) throw new AppError('This provider does not support live input.', { code: 'STEER_UNSUPPORTED', statusCode: 409 });
      const verified = filterAttachmentsToUploadStore(attachments);
      if (verified.length !== attachments.length) throw new AppError('Invalid attachment path.', { code: 'INVALID_ATTACHMENT', statusCode: 400 });
      // The card and automatic dispatcher compete for the same atomic claim.
      // Never inject a message the dispatcher already took or another device edited.
      const candidate = queuedUserId === undefined ? undefined : sessionDraftsDb.listQueuedMessages()
        .find(item => item.userId === queuedUserId && item.sessionId === sessionId);
      if (queuedUserId !== undefined) {
        const queued = candidate?.queuedMessage as Record<string, unknown> | undefined;
        if (!candidate || queued?.content !== content
          || !isDeepStrictEqual(queued.attachments ?? queued.images ?? [], attachments)
          || !sessionDraftsDb.claimQueuedMessage(candidate)) {
          throw new AppError('Queued message was already sent or changed. Refreshing the queue.', { code: 'QUEUE_CHANGED', statusCode: 409 });
        }
      }
      try {
        const attachmentOwner = requestingUserId ?? queuedUserId;
        if (attachmentOwner !== undefined) await retainAttachmentUploads(verified, attachmentOwner);
        const mode = await runtime.prepareInput?.(sessionId) ?? 'live';
        if (mode === 'resume') {
          const owner = dependencies.execution.get(sessionId);
          if (owner?.kind === 'chat') await dependencies.execution.stop(sessionId, owner.id);
          await dependencies.startResumedTurn(sessionId, content, verified, requestingUserId ?? queuedUserId ?? null);
        } else {
          await runtime.steer(sessionId, content, verified);
        }
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (candidate) sessionDraftsDb.restoreQueuedMessage({ ...candidate, claimToken: JSON.stringify({
          ...candidate.queuedMessage as Record<string, unknown>, deliveryError: message,
        }) });
        throw new AppError(message, { code: 'STEER_FAILED', statusCode: 409 });
      }
      if (candidate) sessionDraftsDb.deleteEmptyDraft(candidate.userId, sessionId);
    },

    /** Used by the queue and gateway to avoid replacing a held process. */
    canSteer(sessionId: string): boolean {
      const session = sessionsDb.getSessionById(sessionId);
      return Boolean(session && dependencies.resolveProvider(session.provider).runtime.canSteer?.(sessionId));
    },

    /** Used by chat and queued delivery to recover only an input the provider proves closed. */
    async prepareInput(sessionId: string): Promise<'live' | 'resume'> {
      const session = sessionsDb.getSessionById(sessionId);
      if (!session) throw new AppError('Session not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
      const mode = await dependencies.resolveProvider(session.provider).runtime.prepareInput?.(sessionId) ?? 'live';
      if (mode === 'resume') {
        const owner = dependencies.execution.get(sessionId);
        if (owner?.kind === 'chat') await dependencies.execution.stop(sessionId, owner.id);
      }
      return mode;
    },

    hasRuntime(providerName: string): boolean {
      try {
        return Boolean(dependencies.resolveProvider(providerName).runtime);
      } catch {
        return false;
      }
    },

    getRunner(provider: LLMProvider): ProviderRunFunction {
      return (command, options, writer) => run(provider, command, options, writer);
    },

    async abort(providerName: LLMProvider, sessionId: string): Promise<boolean> {
      const owner = dependencies.execution.get(sessionId, providerName);
      if (owner) {
        await dependencies.execution.stop(sessionId, owner.id);
        return true;
      }
      return Boolean(await dependencies.resolveProvider(providerName).runtime.abort(sessionId));
    },

    async stopBackgroundTask(providerName: LLMProvider, sessionId: string, taskId: string): Promise<boolean> {
      // A runtime that never holds background work has no task to stop.
      const { runtime } = dependencies.resolveProvider(providerName);
      return Boolean(await runtime.stopBackgroundTask?.(sessionId, taskId));
    },

    hasBackgroundWork(sessionId: string): boolean {
      return dependencies.listProviders().some((provider) =>
        (provider.runtime.listBackgroundWork?.() ?? []).some((entry) => entry.sessionId === sessionId));
    },

    resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void {
      for (const provider of dependencies.listProviders()) {
        provider.runtime.permissions?.resolve(requestId, decision);
      }
    },

    getPendingApprovalsForSession(sessionId: string): unknown[] {
      return dependencies.listProviders().flatMap(
        (provider) => provider.runtime.permissions?.listPending(sessionId) ?? [],
      );
    },
  };
}

export const providerRuntimeService = createProviderRuntimeService();
