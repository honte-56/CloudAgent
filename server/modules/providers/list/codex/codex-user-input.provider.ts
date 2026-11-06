import { randomUUID } from 'node:crypto';
import type { AnyRecord, ProviderPermissionDecision } from '@/shared/index.js';

type PendingInput = {
  nativeId: string | number;
  params: AnyRecord;
  view: AnyRecord;
  reply: (result: AnyRecord) => void | Promise<void>;
  responding?: boolean;
};

/** Codex's live runtime uses this bridge for question cards, reconnect snapshots, and exact native answer routing. */
export function createCodexUserInputBridge(sessionId: string, send: (message: AnyRecord) => void,
  onAnswer: (isBlocking: boolean, hasAnswers: boolean, asyncMessage: boolean) => void) {
  const pending = new Map<string, PendingInput>();
  const emit = (kind: string, requestId: string) => send({ kind, requestId, sessionId, provider: 'codex', timestamp: new Date().toISOString() });
  const handle = (method: string, params: AnyRecord, reply: (result: AnyRecord) => void | Promise<void>, nativeId: string | number): boolean => {
    if (method !== 'item/tool/requestUserInput') return false;
    if (!Array.isArray(params.questions) || params.questions.length === 0) throw new Error('Codex returned an empty user-input request');
    const questions = params.questions.map((question: AnyRecord, index: number) => ({
      id: String(question.id ?? index),
      header: typeof question.header === 'string' ? question.header : '',
      question: String(question.question ?? question.title ?? ''),
      options: Array.isArray(question.options) ? question.options.map((option: AnyRecord | string) => typeof option === 'string'
        ? { label: option, description: '' } : { label: String(option.label), description: String(option.description ?? '') }) : [],
      isSecret: question.isSecret === true,
      multiSelect: false,
    }));
    const requestId = `codex-question-${randomUUID()}`;
    const view = { requestId, sessionId, toolName: 'AskUserQuestion', input: { questions },
      context: { provider: 'codex', isBlocking: params.isBlocking !== false } };
    pending.set(requestId, { nativeId, params, view, reply });
    send({ kind: 'permission_request', provider: 'codex', timestamp: new Date().toISOString(), ...view });
    return true;
  };
  return {
    handle,
    get pending() { return pending.size > 0; },
    list() { return [...pending.values()].map(entry => entry.view); },
    resolve(requestId: string, decision: ProviderPermissionDecision) {
      const entry = pending.get(requestId);
      if (!entry || entry.responding) return;
      const supplied = (decision.updatedInput as AnyRecord | undefined)?.answers;
      const answers: Record<string, { answers: string[] }> = {};
      if (decision.allow && supplied && typeof supplied === 'object' && !Array.isArray(supplied)) {
        for (const question of entry.view.input.questions) {
          const value = supplied[question.id] ?? supplied[question.question];
          if (typeof value === 'string' && value.trim()) answers[question.id] = { answers: [value] };
          else if (Array.isArray(value) && value.every(answer => typeof answer === 'string')) answers[question.id] = { answers: value };
        }
      }
      // Reply first. A broken transport must not make a still-pending card
      // disappear or pretend that a selection reached the native session.
      const complete = () => {
        pending.delete(requestId);
        onAnswer(entry.params.isBlocking !== false, Object.keys(answers).length > 0, entry.params.asyncMessage === true);
        emit('permission_resolved', requestId);
      };
      const response = entry.reply({ answers });
      if (response) {
        entry.responding = true;
        void response.then(complete, error => {
          entry.responding = false;
          send({ kind: 'error', id: randomUUID(), timestamp: new Date().toISOString(), sessionId, provider: 'codex', content: error instanceof Error ? error.message : String(error) });
        });
      } else complete();
    },
    resolvedByNative(nativeId: string | number) {
      for (const [requestId, entry] of pending) if (entry.nativeId === nativeId) {
        pending.delete(requestId);
        emit('permission_cancelled', requestId);
      }
    },
    clear() {
      for (const requestId of pending.keys()) emit('permission_cancelled', requestId);
      pending.clear();
    },
  };
}
