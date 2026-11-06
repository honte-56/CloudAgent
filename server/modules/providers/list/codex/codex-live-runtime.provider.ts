import { transformCodexItem } from '@/modules/providers/list/codex/codex-items.provider.js';
import { createCodexUserInputBridge } from '@/modules/providers/list/codex/codex-user-input.provider.js';
import { isImageAttachmentDescriptor, type ChatAttachmentDescriptor } from '@/shared/image-attachments.js';
import { randomUUID } from 'node:crypto';

import { CodexLiveClient } from '@/modules/providers/list/codex/codex-live.client.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { appendFilesInputTag, buildCodexInputItems, createCompleteMessage, createNormalizedMessage } from '@/shared/index.js';
import type { AnyRecord, CodexServerRequestHandler, NativeQueuedMessage, ProviderPermissionDecision, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/index.js';

// Each run owns its child and map entry. An old run's cleanup cannot close or
// remove the newer run that a queued follow-up may already have started.
type LiveClient = Pick<CodexLiveClient, 'initialize' | 'call' | 'close'>;
type LiveRun = { client: LiveClient; threadId: string | null; turnId: string | null; aborted: boolean; closing: boolean; queueMutations: number; receipts: Map<string, Promise<NativeQueuedMessage>>; metadata: Map<string, NativeQueuedMessage>; queuedTurns: Map<string, string | null>; settle?: () => Promise<void>; echoInput: (entry: NativeQueuedMessage, id: string) => void; cancel: () => void };


function turnInput(command: string, options: AnyRecord): AnyRecord[] {
  return buildCodexInputItems(appendFilesInputTag(command, options.files), options.images, options.cwd)
    .map((item) => item.type === 'text'
      ? { type: 'text', text: item.text, text_elements: [] }
      : { type: 'localImage', path: item.path });
}

/** Used by the Codex adapter and provider tests to build an isolated live runtime. */
export function createCodexLiveRuntime(
  makeClient: (notification: (method: string, params: AnyRecord) => void, failure: (error: Error) => void, environment?: NodeJS.ProcessEnv, request?: CodexServerRequestHandler) => LiveClient =
    (notification, failure, environment, request) => new CodexLiveClient(notification, failure, undefined, environment, request),
) {
const runs = new Map<string, LiveRun>();
const questions = new Map<string, ReturnType<typeof createCodexUserInputBridge>>();
async function runLive(command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext): Promise<void> {
  const key = options.sessionId || randomUUID();
  let finish!: (turn: AnyRecord) => void;
  let fail!: (error: Error) => void;
  const completion = new Promise<AnyRecord>((resolve, reject) => { finish = resolve; fail = reject; });
  // A process error can arrive during initialization, before completion is awaited.
  void completion.catch(() => {});
  const send = (message: unknown) => writer.send(writer.isWebSocketWriter ? message : JSON.stringify(message));
  const items = new Map<string, AnyRecord>();
  const run: LiveRun = { client: null as unknown as LiveClient, threadId: null, turnId: null, aborted: false, closing: false, queueMutations: 0, receipts: new Map(), metadata: new Map(), queuedTurns: new Map(), echoInput: (entry, id) => send(createNormalizedMessage({ kind: 'text', role: 'user', content: entry.content, images: entry.attachments.filter(isImageAttachmentDescriptor), files: entry.attachments.filter(file => !isImageAttachmentDescriptor(file)), provider: 'codex', sessionId: run.threadId || key, id })), cancel: () => finish({ status: 'interrupted' }) };
  const normalizeItem = (item: AnyRecord) => {
    const raw = transformCodexItem(item);
    if (raw) for (const message of context.normalizeMessage(raw, run.threadId || key)) send(message);
  };
  let lastCompleted: AnyRecord | null = null;
  let awaitingAnswerTurn = false;
  const userInput = createCodexUserInputBridge(key, send, (isBlocking, hasAnswers, asyncMessage) => {
    // An async answer after the original turn has finished starts a new native
    // turn. Keep the owner alive through the gap before turn/started arrives.
    awaitingAnswerTurn = !asyncMessage && !isBlocking && hasAnswers && !run.turnId;
    if (!awaitingAnswerTurn) void run.settle?.();
  });
  questions.set(key, userInput);
  run.settle = async () => {
    try {
    if (!lastCompleted || run.turnId || run.queueMutations || run.closing || userInput.pending || awaitingAnswerTurn) return;
    if (lastCompleted.status === 'completed') {
      const queued = await run.client.call('thread/queue/list', { threadId: run.threadId, limit: 100 });
      // Queue dispatch may already have started the next turn before the list
      // response arrives. Keep the same process, stream, and execution lock.
      if (run.turnId || run.queueMutations || queued.data?.length || run.queuedTurns.size || userInput.pending || awaitingAnswerTurn) return;
    }
    run.closing = true;
    finish(lastCompleted);
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  };
  try {
    run.client = makeClient((method, params) => {
      if (params.threadId && run.threadId && params.threadId !== run.threadId) return;
      if (method === 'turn/started') { run.turnId = params.turn.id; awaitingAnswerTurn = false; }
      if (method === 'serverRequest/resolved') { userInput.resolvedByNative(params.requestId); void run.settle?.(); }
      if (method === 'turn/completed') {
        if (run.turnId && params.turn.id !== run.turnId) return;
        for (const [id, turnId] of run.queuedTurns) if (turnId === params.turn.id) run.queuedTurns.delete(id);
        run.turnId = null;
        lastCompleted = params.turn;
        void run.settle?.().catch(fail);
      }
      if (method === 'item/started' && params.item?.type === 'userMessage') {
        const clientId = params.item.clientId ?? params.item.client_id;
        if (run.queuedTurns.has(clientId)) run.queuedTurns.set(clientId, params.turnId ?? run.turnId);
        const queued = run.metadata.get(clientId);
        if (queued) {
          run.echoInput(queued, clientId);
          run.metadata.delete(clientId);
        }
      }
      if (method === 'thread/queue/changed') void run.settle?.().catch(fail);
      if (method === 'item/completed' && params.item?.type === 'agentMessage' && Array.isArray(params.item.questions) && params.item.questions.length) {
        const item = params.item;
        const questionList = item.questions.map((question: AnyRecord, index: number) => ({
          id: String(index), question: question.title, options: question.options ?? [],
        }));
        const answerId = randomUUID();
        userInput.handle('item/tool/requestUserInput', { questions: questionList, isBlocking: false, asyncMessage: true }, async response => {
          const answers = response.answers as Record<string, { answers: string[] }>;
          const content = questionList.filter((question: AnyRecord) => answers[question.id]?.answers.length)
            .map((question: AnyRecord) => `${question.question}\n${answers[question.id].answers.join(', ')}`).join('\n\n');
          if (!content) return;
          run.queueMutations++;
          run.queuedTurns.set(answerId, null);
          try {
            await run.client.call('turn/start', { threadId: run.threadId, clientUserMessageId: answerId, input: turnInput(content, {}) });
            run.echoInput({ id: answerId, content, attachments: [] }, answerId);
          } catch (error) { run.queuedTurns.delete(answerId); throw error; } finally { run.queueMutations--; }
        }, item.id);
      }
      if (method === 'item/started' || method === 'item/completed') {
        const item = params.item;
        // Store only running tools, bounded independently of conversation length.
        if (method === 'item/started' && ['commandExecution', 'mcpToolCall'].includes(item.type)) {
          if (items.size < 256) items.set(item.id, item);
          normalizeItem(item);
        } else if (method === 'item/completed') {
          items.delete(item.id);
          normalizeItem(item);
        }
      }
      if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
        const messageKey = `codex:${params.itemId}`;
        send(createNormalizedMessage({ id: messageKey, messageKey, kind: 'stream_delta',
          content: params.delta, provider: 'codex', sessionId: run.threadId || key }));
      }
      if (method === 'item/commandExecution/outputDelta') {
        const item = items.get(params.itemId);
        if (item) {
          item.aggregatedOutput = ((item.aggregatedOutput || '') + params.delta).slice(-1024 * 1024);
          normalizeItem(item);
        }
      }
      if (method === 'turn/plan/updated') {
        // A plan notification has no tool-call identity. Refresh the recorded
        // update_plan call rather than inventing a second transcript item.
        send(createNormalizedMessage({ kind: 'status', historyChanged: true, provider: 'codex', sessionId: run.threadId || key }));
      }
      if (method === 'thread/tokenUsage/updated') {
        const usage = params.tokenUsage;
        send(createNormalizedMessage({ kind: 'status', text: 'token_budget', provider: 'codex', sessionId: run.threadId || key, tokenBudget: { used: usage.total.totalTokens, total: usage.modelContextWindow || 200000, inputTokens: usage.total.inputTokens, outputTokens: usage.total.outputTokens, breakdown: { input: usage.total.inputTokens, output: usage.total.outputTokens } } }));
      }
      if (method === 'error' && !params.willRetry) fail(new Error(params.error?.message || 'Codex run failed'));
    }, fail, options.environment, (method, params, reply, nativeId) => {
      if (params.threadId && run.threadId && params.threadId !== run.threadId) return false;
      return userInput.handle(method, params, reply, nativeId);
    });
    runs.set(key, run);
    await run.client.initialize();
    const model = await context.resolveResumeModel(options.sessionId, options.model);
    const catalog = await context.getProviderModels();
    const allowedEfforts = catalog.OPTIONS.find((entry) => entry.value === model)?.effort?.values?.map((entry) => entry.value) || [];
    const nativeId = context.resolveProviderSessionId(options.sessionId);
    const bypass = options.permissionMode === 'bypassPermissions';
    const thread = await run.client.call(nativeId ? 'thread/resume' : 'thread/start', {
      ...(nativeId ? { threadId: nativeId } : {}), model,
      ...(options.environment ? { config: { 'shell_environment_policy.ignore_default_excludes': true } } : {}),
      cwd: options.cwd || options.projectPath || process.cwd(),
      sandbox: bypass ? 'danger-full-access' : 'workspace-write',
      approvalPolicy: bypass || options.permissionMode === 'acceptEdits' ? 'never' : 'on-request',
    });
    if (typeof thread.thread?.id !== 'string') throw new Error('Codex returned no thread id.');
    const threadId: string = thread.thread.id;
    run.threadId = threadId;
    writer.setSessionId?.(threadId);
    if (!nativeId) send(createNormalizedMessage({ kind: 'session_created', provider: 'codex', sessionId: run.threadId, newSessionId: run.threadId }));
    if (run.aborted) return;
    const started = await run.client.call('turn/start', { threadId: run.threadId, input: turnInput(command, options), ...(allowedEfforts.includes(options.effort) ? { effort: options.effort } : {}) });
    // The started notification may precede the response; a very fast turn may
    // even finish first. Do not resurrect its id after completion.
    if (started.turn.status === 'inProgress' && run.turnId) run.turnId = started.turn.id;
    const turn = await completion;
    if (!run.aborted) {
      if (turn.status === 'failed') throw new Error(turn.error?.message || 'Codex turn failed');
      const interrupted = turn.status === 'interrupted';
      send(createCompleteMessage({ provider: 'codex', sessionId: run.threadId, actualSessionId: run.threadId, exitCode: 0, ...(interrupted ? { aborted: true } : {}) }));
      notifyRunStopped({ userId: writer.userId || null, provider: 'codex', sessionId: key, sessionName: options.sessionSummary, stopReason: interrupted ? 'aborted' : 'completed' });
    }
  } catch (error) {
    if (!run.aborted) {
      send(createNormalizedMessage({ kind: 'error', provider: 'codex', sessionId: run.threadId || key, content: error instanceof Error ? error.message : String(error) }));
      send(createCompleteMessage({ provider: 'codex', sessionId: run.threadId || key, exitCode: 1 }));
      notifyRunFailed({ userId: writer.userId || null, provider: 'codex', sessionId: key, sessionName: options.sessionSummary, error });
    }
  } finally {
    // A local abort suppresses late frames but still emits one lifecycle notice.
    if (run.aborted) notifyRunStopped({ userId: writer.userId || null, provider: 'codex', sessionId: key, sessionName: options.sessionSummary, stopReason: 'aborted' });
    userInput.clear();
    if (questions.get(key) === userInput) questions.delete(key);
    run.client?.close();
    if (runs.get(key) === run) runs.delete(key);
  }
}

// Idle reads/deletes use native storage without resuming a thread or claiming
// another executor. They must never start a competing agent process.
async function withQueueClient<T>(sessionId: string, nativeId: string | null | undefined, operation: (client: LiveClient, threadId: string, run?: LiveRun) => Promise<T>): Promise<T> {
  const active = runs.get(sessionId);
  if (active?.threadId && !active.closing) return operation(active.client, active.threadId, active);
  if (!nativeId) throw new Error('The native conversation has not been created yet.');
  const client = makeClient(() => {}, () => {});
  try { await client.initialize(); return await operation(client, nativeId); }
  finally { client.close(); }
}
const fromNative = (entry: AnyRecord, run?: LiveRun): NativeQueuedMessage => ({
  ...(run?.metadata.get(entry.clientUserMessageId) ?? {
    content: (entry.input ?? []).filter((item: AnyRecord) => item.type === 'text').map((item: AnyRecord) => item.text).join('\n'),
    attachments: (entry.input ?? []).filter((item: AnyRecord) => item.type === 'localImage').map((item: AnyRecord) => ({ path: item.path, name: item.path.split('/').pop(), mimeType: 'image/png' })),
  }), id: entry.id,
});
const queue = {
  async list(sessionId: string, nativeId?: string | null): Promise<NativeQueuedMessage[]> {
    if (!nativeId && !runs.get(sessionId)?.threadId) return [];
    return withQueueClient(sessionId, nativeId, async (client, threadId, run) => {
      const result = await client.call('thread/queue/list', { threadId, limit: 100 });
      return (result.data ?? []).map((entry: AnyRecord) => fromNative(entry, run));
    });
  },
  async add(sessionId: string, content: string, attachments: ChatAttachmentDescriptor[], requestId: string): Promise<NativeQueuedMessage> {
    const run = runs.get(sessionId);
    if (!run?.threadId || run.closing || run.aborted) throw new Error('The current task has ended. Send this message normally.');
    const existing = run.receipts.get(requestId);
    if (existing) return existing;
    run.queueMutations++;
    run.metadata.set(requestId, { id: requestId, content, attachments });
    run.queuedTurns.set(requestId, null);
    const receipt = (async () => {
      const result = await run.client.call('thread/queue/add', { threadId: run.threadId, clientUserMessageId: requestId,
        input: turnInput(content, { images: attachments.filter(isImageAttachmentDescriptor), files: attachments.filter(file => !isImageAttachmentDescriptor(file)) }) });
      const entry = { id: result.queuedSubmission.id, content, attachments };
      if (run.metadata.has(requestId)) run.metadata.set(requestId, entry);
      return entry;
    })().catch(error => { run.queuedTurns.delete(requestId); run.metadata.delete(requestId); throw error; }).finally(() => { run.queueMutations--; void run.settle?.(); });
    run.receipts.set(requestId, receipt);
    return receipt;
  },
  async cancel(sessionId: string, id: string, nativeId?: string | null): Promise<boolean> {
    return withQueueClient(sessionId, nativeId, async (client, threadId, run) => {
      const deleted = Boolean((await client.call('thread/queue/delete', { threadId, queuedSubmissionId: id })).deleted);
      if (deleted && run) {
        for (const [clientId, entry] of run.metadata) if (entry.id === id) {
          run.metadata.delete(clientId); run.queuedTurns.delete(clientId);
        }
        void run.settle?.();
      }
      return deleted;
    });
  },
  async sendNow(sessionId: string, id: string): Promise<void> {
    const run = runs.get(sessionId);
    if (!run?.threadId || run.closing || run.aborted) throw new Error('The active task has ended; the native queue will resume with the conversation.');
    run.queueMutations++;
    try {
      const result = await run.client.call('thread/queue/list', { threadId: run.threadId, limit: 100 });
      const entry = result.data?.find((item: AnyRecord) => item.id === id);
      if (!entry) return; // Native dispatcher already consumed it.
      const displayEntry = fromNative(entry, run);
      if (!(await run.client.call('thread/queue/delete', { threadId: run.threadId, queuedSubmissionId: id })).deleted) return;
      // turn/start steers an active turn and starts one at an idle boundary.
      // Once deleted, an uncertain response is never automatically replayed.
      try {
        await run.client.call('turn/start', { threadId: run.threadId, input: entry.input, clientUserMessageId: entry.clientUserMessageId });
        // Admission is enough to display the user's input; do not wait for a
        // running tool to finish. The later native echo has this same row ID.
        run.echoInput(displayEntry, entry.clientUserMessageId);
      } catch (error) {
        run.queuedTurns.delete(entry.clientUserMessageId);
        run.metadata.delete(entry.clientUserMessageId);
        throw error;
      }
    } finally { run.queueMutations--; void run.settle?.(); }
  },
};
return {
  permissions: {
    resolve(requestId: string, decision: ProviderPermissionDecision) { for (const bridge of questions.values()) bridge.resolve(requestId, decision); },
    listPending(sessionId: string) { return questions.get(sessionId)?.list() ?? []; },
  },
  queue,
  run: runLive,
  abort(sessionId: string): boolean {
    const run = runs.get(sessionId);
    if (!run) return false;
    run.aborted = true;
    // Closing this run's child cancels initialization as well as active tools.
    run.client.close();
    run.cancel();
    return true;
  },
  async steer(sessionId: string, content: string, attachments: ChatAttachmentDescriptor[] = []): Promise<void> {
    const run = runs.get(sessionId);
    if (!run?.threadId || !run.turnId || run.aborted) throw new Error('当前任务尚未开始或已经结束，请稍后重试或使用普通发送。');
    await run.client.call('turn/steer', { threadId: run.threadId, expectedTurnId: run.turnId, input: turnInput(content, { images: attachments.filter(isImageAttachmentDescriptor), files: attachments.filter(file => !isImageAttachmentDescriptor(file)) }) });
  },
};
}

/** Used by the Codex provider for app-server turns and in-place steering. */
export const codexLiveRuntime = createCodexLiveRuntime();
