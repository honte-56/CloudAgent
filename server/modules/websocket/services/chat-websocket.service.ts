import { retainAttachmentUploads } from '@/modules/assets/index.js';

import type { WebSocket } from 'ws';

import { sessionsDb } from '@/modules/database/index.js';
import { providerModelsService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { acknowledgeChatSend, withChatReceipt } from '@/modules/websocket/services/chat-receipts.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import {
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  type ChatAttachmentDescriptor,
} from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
  ProviderRunReservation,
  SessionExecutionOwner,
} from '@/shared/types.js';
import { filterAttachmentsToUploadStore, parseIncomingJsonObject } from '@/shared/utils.js';

// One cancellation per run, shared by repeated Stop requests and dispatch
// cleanup. Weak keys keep a cancelled run's outcome from affecting later runs.
const pendingRunAborts = new WeakMap<NonNullable<ReturnType<typeof chatRunRegistry.getRun>>, Promise<boolean>>();

/** Coordinates cancellation with a dispatch that may settle before ownership releases. */
function abortRegisteredRun(
  run: ReturnType<typeof chatRunRegistry.getRun>,
  provider: LLMProvider,
  sessionId: string,
  dependencies: ChatWebSocketDependencies,
): Promise<boolean> {
  if (!run) return dependencies.runtime.abort(provider, sessionId);
  const existing = pendingRunAborts.get(run);
  if (existing) return existing;
  // Register before invoking the runtime, which can synchronously settle its run.
  const pending = Promise.resolve().then(() => dependencies.runtime.abort(provider, sessionId));
  pendingRunAborts.set(run, pending);
  void pending.then(
    (success) => { if (!success) pendingRunAborts.delete(run); },
    () => { pendingRunAborts.delete(run); },
  );
  return pending;
}

// Kept for existing gateway consumers; HTTP live input uses the same boundary.
export { filterAttachmentsToUploadStore } from '@/shared/utils.js';

/** Backward-compatible image filter consumed by existing websocket tests. */
export function filterImagesToUploadStore(
  images: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  return filterAttachmentsToUploadStore(images, assetsRootOverride);
}

/** Application boundary for dispatching provider runs and approvals. */
export type ProviderRuntimeGateway = {
  hasRuntime(provider: string): boolean;
  reserveRun?(provider: LLMProvider, sessionId: string): ProviderRunReservation;
  getExecutionOwner?(sessionId: string): SessionExecutionOwner | null;
  run(
    provider: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown>;
  abort(provider: LLMProvider, sessionId: string): Promise<boolean>;
  stopBackgroundTask(provider: LLMProvider, sessionId: string, taskId: string): Promise<boolean>;
  /** Whether a provider runtime still holds background work for the session after its turn ended. */
  hasBackgroundWork(sessionId: string): boolean;
  /** Reuses an owned input stream; absence means this provider cannot append. */
  steer?(sessionId: string, content: string, attachments?: unknown[]): Promise<void>;
  canSteer?(sessionId: string): boolean;
  prepareInput?(sessionId: string): Promise<'live' | 'resume'>;
  resolveToolApproval(requestId: string, payload: ProviderPermissionDecision): void;
  getPendingApprovalsForSession(sessionId: string): unknown[];
};

type ChatWebSocketDependencies = {
  /** Central dispatcher for every provider SDK/CLI runtime. */
  runtime: ProviderRuntimeGateway;
};

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string,
  extra: AnyRecord = {}
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
    ...extra,
  });
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

/**
 * Handles `chat.send`: resolves the session row (provider, project path, and
 * provider-native id all come from the database — never from the client),
 * registers the run, and dispatches to the provider runtime.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const resolved = resolveSendTarget(ws, data, dependencies, 'chat.send');
  if (!resolved) {
    return;
  }

  // A monitor can finish just before its notification starts the next one.
  // An empty task list must not replace an input-capable CLI in that gap.
  if (!chatRunRegistry.isProcessing(resolved.sessionId)
    && (dependencies.runtime.hasBackgroundWork(resolved.sessionId) || dependencies.runtime.canSteer?.(resolved.sessionId))) {
    try {
      const mode = await dependencies.runtime.prepareInput?.(resolved.sessionId) ?? 'live';
      if (mode === 'live') {
        if (!dependencies.runtime.steer) throw new Error('This provider does not support live input.');
        await retainAttachmentUploads(filterAttachmentsToUploadStore(data.options?.attachments ?? []), Number(userId));
        await dependencies.runtime.steer(resolved.sessionId, typeof data.content === 'string' ? data.content : '', data.options?.attachments ?? []);
        acknowledgeChatSend(data);
        return;
      }
    } catch (error) {
      sendProtocolError(ws, 'LIVE_INPUT_FAILED', error instanceof Error ? error.message : String(error), resolved.sessionId);
      return;
    }
  }
  await dispatchRun(ws, userId, resolved.sessionId, resolved.session, data, dependencies);
}

type ResolvedSendTarget = {
  sessionId: string;
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;
  provider: LLMProvider;
};

/**
 * Shared front half of `chat.send` and `chat.edit-send`: the session row and
 * provider come from the database, never from the client.
 */
function resolveSendTarget(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  frameName: string,
): ResolvedSendTarget | null {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', `${frameName} requires a sessionId.`);
    return null;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId
    );
    return null;
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    return null;
  }

  return { sessionId, session, provider };
}

/**
 * Registers the run and hands the turn to the provider runtime.
 *
 * `extraRuntimeOptions` is how an edited message asks the provider to resume
 * partway instead of continuing from the tip; a normal send passes nothing.
 */
async function dispatchRun(
  ws: WebSocket | null,
  userId: string | number | null,
  sessionId: string,
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  extraRuntimeOptions: AnyRecord = {},
  beforeRun?: (run: NonNullable<ReturnType<typeof chatRunRegistry.startRun>>) => void | Promise<void>,
  onAccepted?: () => void,
): Promise<{ started: boolean; error: string | null }> {
  const provider = session.provider as LLMProvider;

  let reservation: ProviderRunReservation | undefined;
  try {
    if (!chatRunRegistry.isProcessing(sessionId)) reservation = dependencies.runtime.reserveRun?.(provider, sessionId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (ws) sendProtocolError(ws, 'SESSION_OWNED', detail, sessionId);
    return { started: false, error: detail };
  }

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
  });

  if (!run) {
    reservation?.release();
    if (ws) {
      sendProtocolError(
        ws,
        'RUN_IN_PROGRESS',
        `Session "${sessionId}" already has a run in progress.`,
        sessionId
      );
    }
    return { started: false, error: 'A run is already in progress for this session.' };
  }

  let failure: string | null = null;
  try {
    const clientOptions = (data.options ?? {}) as AnyRecord;
    const command = typeof data.content === 'string' ? data.content : '';

    // Record what this turn runs with so reopening the session later restores the
    // same model and reasoning effort, and so the resume path has a
    // session-scoped model answer to use.
    if (typeof clientOptions.model === 'string' && clientOptions.model.trim()) {
      providerModelsService.setSessionModel(provider, sessionId, clientOptions.model);
    }
    if (typeof clientOptions.effort === 'string' && clientOptions.effort.trim()) {
      providerModelsService.setSessionEffort(provider, sessionId, clientOptions.effort);
    }

    const attachmentCandidates = [
      ...normalizeAttachmentDescriptors(clientOptions.images),
      ...normalizeAttachmentDescriptors(clientOptions.files),
      ...normalizeAttachmentDescriptors(clientOptions.attachments),
    ];
    const verifiedAttachments = filterAttachmentsToUploadStore(attachmentCandidates);
    const uniqueAttachments = verifiedAttachments.filter(
      (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
    );

    // The provider runtimes receive the stable app session id. When their
    // CLI/SDK needs the provider-native id for resume, they resolve it from the
    // session row themselves (sessionsService.resolveProviderSessionId).
    // Brand-new sessions have no provider id yet, so the runtime starts fresh
    // and announces one, which the gateway writer captures and maps back to the
    // app session id.
    const runtimeOptions: AnyRecord = {
      ...clientOptions,
      ...extraRuntimeOptions,
      // Attachments are re-validated server-side: only direct children of the
      // global upload store may reach provider runtimes or their file tools.
      attachments: uniqueAttachments,
      images: uniqueAttachments.filter(isImageAttachmentDescriptor),
      files: uniqueAttachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor)),
      sessionId,
      // A browser opened before a directory change must not restore the old cwd.
      cwd: session.project_path ?? clientOptions.cwd ?? undefined,
      projectPath: session.project_path ?? clientOptions.projectPath,
    };

    // Runs only now that the session is reserved, because an edit rewinds the
    // conversation here and a rewind for a run that was never admitted cannot
    // be taken back. Inside the try so a rewind that throws still releases the
    // run instead of leaving the session processing forever.
    await beforeRun?.(run);
    await retainAttachmentUploads(uniqueAttachments, Number(userId));
    acknowledgeChatSend(data);
    onAccepted?.();
    if (reservation) await reservation.run(command, runtimeOptions, run.writer);
    else await dependencies.runtime.run(provider, command, runtimeOptions, run.writer);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: failure });
  } finally {
    reservation?.release();
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    const abort = pendingRunAborts.get(run);
    if (abort) {
      // Ownership release waits for this dispatch to settle. Do not await the
      // abort here: defer its terminal outcome without creating a wait cycle.
      void abort.then(
        (success) => chatRunRegistry.completeRunIfCurrent(run, { exitCode: success ? 0 : 1, aborted: success }),
        () => chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 }),
      );
    } else {
      chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
    }
  }

  return { started: true, error: failure };
}

/**
 * Handles `chat.edit-send`: replaces an already-sent message and everything
 * after it with a new turn.
 *
 * Nothing is deleted. The provider resumes the conversation partway and
 * appends the replacement, so the abandoned attempt stays in the transcript
 * file and is simply no longer part of the live conversation — the same shape
 * Claude Code's rewind and Codex's fork-with-cut-point produce.
 */
async function handleChatEditSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const resolved = resolveSendTarget(ws, data, dependencies, 'chat.edit-send');
  if (!resolved) {
    return;
  }

  const { sessionId, session, provider } = resolved;
  const anchorId = typeof data.anchorId === 'string' ? data.anchorId.trim() : '';
  if (!anchorId) {
    sendProtocolError(ws, 'ANCHOR_REQUIRED', 'chat.edit-send requires the anchorId of the message being replaced.', sessionId);
    return;
  }

  let resumeThroughId: string | null;
  try {
    const anchor = await sessionsService.resolveEditAnchor(sessionId, anchorId);
    if (!anchor) {
      sendProtocolError(
        ws,
        'EDIT_NOT_SUPPORTED',
        `Provider "${provider}" cannot replace an already-sent message.`,
        sessionId
      );
      return;
    }
    if (!anchor.found) {
      sendProtocolError(ws, 'ANCHOR_NOT_FOUND', 'That message is no longer in the transcript.', sessionId);
      return;
    }
    resumeThroughId = anchor.resumeThroughId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendProtocolError(ws, 'ANCHOR_LOOKUP_FAILED', `Could not read the transcript: ${message}`, sessionId);
    return;
  }

  // Providers split here on what their runtime can do. Claude resumes its
  // transcript partway, so the anchor rides along as a run option. Codex
  // cannot — a thread only grows — so the conversation is rewound on disk and
  // the run that follows is an ordinary resume of whatever the session then
  // points at. Which of the two applies is decided here; the rewind itself
  // waits until the run has actually been admitted.
  const rewinds = sessionsService.providerRewindsForEdit(sessionId);

  await dispatchRun(
    ws,
    userId,
    sessionId,
    session,
    data,
    dependencies,
    // `null` is meaningful: the edited turn was the first prompt, so the
    // conversation starts over instead of resuming.
    rewinds
      ? {}
      : { resumeAnchorId: resumeThroughId ?? undefined, resumeFromScratch: resumeThroughId === null },
    async (run) => {
      // Emitted through the run's writer so it is sequenced and replayed like
      // any other event — a second tab watching this session has to truncate
      // too.
      //
      // Before the rewind, not after it. A rewind that has to branch spawns a
      // process and waits on a JSON-RPC round trip, and holding the frame
      // until that came back left the message the user had just edited away
      // sitting on screen for about a second — the very flicker this feature
      // exists to avoid. Announcing first is safe because a rewind that fails
      // still ends the run, and the terminal `complete` makes every client
      // re-read the transcript, which puts back anything that turned out not
      // to have been replaced after all.
      run.writer.send({
        kind: 'history_truncated',
        provider,
        sessionId,
        anchorId,
      });

      if (rewinds) {
        try {
          await sessionsService.rewindSessionForEdit(sessionId, resumeThroughId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendProtocolError(ws, 'EDIT_REWIND_FAILED', `Could not rewind the conversation: ${message}`, sessionId);
          // Ends the run before the provider is asked to continue a
          // conversation that was not rewound after all.
          throw error;
        }
      }
    },
  );
}

/**
 * Handles `chat.abort`: cancels the run for one app session and emits the
 * terminal `complete` on its behalf (runtimes skip their own complete for
 * aborted runs, and the registry drops any duplicate).
 */
async function handleChatAbort(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  const session = sessionsDb.getSessionById(sessionId);
  if ((!run || run.status !== 'running') && !dependencies.runtime.hasBackgroundWork(sessionId)
    && !dependencies.runtime.getExecutionOwner?.(sessionId)) {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  const provider = run?.provider ?? session?.provider as LLMProvider | undefined;
  if (!provider) return;
  const success = await abortRegisteredRun(run, provider, sessionId, dependencies);
  if (!success) {
    sendProtocolError(ws, 'ABORT_FAILED', 'The session could not be stopped. Its running state has been retained.', sessionId);
    return;
  }

  // Scoped to the run that was stopped: a stop can take a round trip, and a
  // new run of the session may have started by the time it returns.
  if (run) chatRunRegistry.completeRunIfCurrent(run, {
    exitCode: success ? 0 : 1,
    aborted: true,
  });
}

/**
 * Handles `chat.stop-task`: stops one background task of a session — an
 * agent, a workflow or a backgrounded command that is still going after its
 * turn ended. Unlike `chat.abort` there is no run to consult: the task lives
 * in the provider's held process, which is the only thing that can stop it.
 * The provider then reports the task as stopped on the session's stream, so
 * nothing is echoed back here on success.
 */
async function handleChatStopTask(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.stop-task requires a sessionId.');
    return;
  }

  const taskId = typeof data.taskId === 'string' ? data.taskId.trim() : '';
  if (!taskId) {
    sendProtocolError(ws, 'TASK_ID_REQUIRED', 'chat.stop-task requires a taskId.', sessionId);
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(ws, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`, sessionId);
    return;
  }

  const stopped = await dependencies.runtime.stopBackgroundTask(
    session.provider as LLMProvider,
    sessionId,
    taskId,
  );
  if (!stopped) {
    sendProtocolError(
      ws,
      'NO_SUCH_TASK',
      `Session "${sessionId}" has no running background task "${taskId}".`,
      sessionId,
      // Names the task so the client can settle a chip whose end it missed.
      { taskId },
    );
  }
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;

    const run = chatRunRegistry.getRun(sessionId);
    // Flush before attaching the new socket: otherwise it can receive a suffix
    // delta first and then reject the complete replay snapshot with the same seq.
    run?.writer.flush();
    const isProcessing = chatRunRegistry.isProcessing(sessionId);

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
    // A session whose turn ended but whose background work is still going
    // keeps producing events through the same writer (task progress, the
    // turn the CLI pushes when a task reports), so a tab opened during that
    // work attaches too; the registry keeps the run while the work lasts.
    if (isProcessing || dependencies.runtime.hasBackgroundWork(sessionId)) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // Pending approvals are tracked under the app session id inside the
    // Claude runtime, so they can be looked up directly.
    const pendingPermissions = dependencies.runtime.getPendingApprovalsForSession(sessionId);

    sendJson(ws, {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      lastSeq: chatRunRegistry.getCursor(sessionId),
      resetCursor: lastSeq > chatRunRegistry.getCursor(sessionId),
      historyRequired: true,
      pendingPermissions,
      timestamp: new Date().toISOString(),
    });

    // The ack owns current runtime/permission state. Historical control events
    // must not idle a newer turn or reopen an already answered approval.
    const cursor = chatRunRegistry.getCursor(sessionId);
    const replayAfter = lastSeq > cursor ? 0 : lastSeq;
    for (const event of chatRunRegistry.replayEvents(sessionId, replayAfter)) {
      // Older builds incorrectly journaled Codex lifecycle signals as tools.
      if (event.provider === 'codex' && (['subAgentActivity', 'SubAgentActivity'].includes(event.toolName || '')
        || event.toolName === 'TodoWrite' && (event.toolId || event.id).endsWith('-plan'))) continue;
      if (['complete', 'status', 'permission_request', 'permission_resolved', 'permission_cancelled', 'session_created'].includes(event.kind)) continue;
      sendJson(ws, { ...event, isReplay: true });
    }
    sendJson(ws, { kind: 'chat_replay_complete', sessionId, cursor, isProcessing });
  }
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  dependencies.runtime.resolveToolApproval(data.requestId, {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  });
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options? }
 * - `chat.abort`               { sessionId }
 * - `chat.stop-task`           { sessionId, taskId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`).
 */
/**
 * Runs a turn for a session with no client attached.
 *
 * Used by scheduled messages, which fire from a timer: there is no socket to
 * report errors to and no audience to stream to. The run is registered exactly
 * like an interactive one, so anyone who opens the session while it is going
 * subscribes and replays it from the start, and the session shows as busy
 * everywhere in the meantime.
 *
 * Resolves when the provider run settles. Returns false when the session has
 * gone away or is busy without `interruptActiveRun`, which the caller reports
 * on the schedule.
 */
export async function runDetachedChatTurn(
  input: {
    sessionId: string;
    userId: string | number | null;
    content: string;
    options?: AnyRecord;
    /**
     * Aborts a run already in progress instead of refusing to start. A
     * scheduled message sets this: the user picked the time knowing it might
     * land mid-run, so the timer outranks whatever is running.
     */
    interruptActiveRun?: boolean;
    /** Internal admission callback for an HTTP send that must not wait for the entire agent turn. */
    onAccepted?: () => void;
  },
  dependencies: ChatWebSocketDependencies,
): Promise<{ started: boolean; error: string | null }> {
  const session = sessionsDb.getSessionById(input.sessionId);
  if (!session) {
    return { started: false, error: 'The session no longer exists.' };
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    return { started: false, error: `Provider "${provider}" is not available.` };
  }

  if (!chatRunRegistry.isProcessing(input.sessionId)
    && (dependencies.runtime.hasBackgroundWork(input.sessionId) || dependencies.runtime.canSteer?.(input.sessionId))) {
    try {
      const mode = await dependencies.runtime.prepareInput?.(input.sessionId) ?? 'live';
      if (mode === 'live') {
        if (!dependencies.runtime.steer) throw new Error('This provider does not support live input.');
        await retainAttachmentUploads(filterAttachmentsToUploadStore(input.options?.attachments ?? []), Number(input.userId));
        await dependencies.runtime.steer(input.sessionId, input.content, input.options?.attachments ?? []);
        input.onAccepted?.();
        return { started: true, error: null };
      }
    } catch (error) {
      return { started: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const activeRun = chatRunRegistry.getRun(input.sessionId);
  if (activeRun && activeRun.status === 'running') {
    if (!input.interruptActiveRun) {
      return { started: false, error: 'A run was already in progress for this session.' };
    }
    // Same shape as `chat.abort`: cancel the provider run and emit the
    // terminal `complete` on its behalf, so every watching client sees the
    // interrupted run end before this turn's stream begins. The interrupted
    // run's own dispatch settles later through completeRunIfCurrent, which is
    // scoped to that run and cannot touch the one started here.
    const aborted = await abortRegisteredRun(activeRun, activeRun.provider, input.sessionId, dependencies);
    chatRunRegistry.completeRunIfCurrent(activeRun, {
      exitCode: aborted ? 0 : 1,
      aborted: true,
    });
  }

  return dispatchRun(
    null,
    input.userId,
    input.sessionId,
    session,
    { sessionId: input.sessionId, content: input.content, options: input.options ?? {} },
    dependencies,
    {},
    undefined,
    input.onAccepted,
  );
}

/** Used by Providers to resume a proven closed input and acknowledge admission without waiting for background work to finish. */
export function startDetachedChatTurn(
  input: Parameters<typeof runDetachedChatTurn>[0],
  dependencies: ChatWebSocketDependencies,
): Promise<void> {
  return new Promise((resolve, reject) => {
    void runDetachedChatTurn({ ...input, onAccepted: resolve }, dependencies)
      .then(result => { if (!result.started) reject(new Error(result.error ?? 'Could not resume the conversation.')); })
      .catch(reject);
  });
}

export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = readRequestUserId(request);

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.ping':
          // Application heartbeat lets browsers detect half-open transports;
          // native WebSocket ping/pong is invisible to browser JavaScript.
          ws.send(JSON.stringify({ kind: 'chat_pong' }));
          return;
        case 'chat.edit-send':
          await withChatReceipt(ws, userId, data, () => handleChatEditSend(ws, userId, data, dependencies));
          return;
        case 'chat.send':
          await withChatReceipt(ws, userId, data, () => handleChatSend(ws, userId, data, dependencies));
          return;
        case 'chat.abort':
          await handleChatAbort(ws, data, dependencies);
          return;
        case 'chat.stop-task':
          await handleChatStopTask(ws, data, dependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, data, dependencies);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(data, dependencies);
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
  });
}
