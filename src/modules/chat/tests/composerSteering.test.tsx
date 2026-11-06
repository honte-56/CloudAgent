import assert from 'node:assert/strict';
import { act, renderHook, render, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { PromptInput } from '@/modules/chat/composer/PromptInput';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readDraftText, readQueuedMessage, writeQueuedMessage, resetChatDrafts } from '@/shared/chatDrafts';
import type { ChatMessage, PermissionMode, Project } from '@/shared/types';

const { steerSession, uploadAttachment, native } = vi.hoisted(() => ({ steerSession: vi.fn(), uploadAttachment: vi.fn(), native: new Map<string, Array<any>>() }));
vi.mock('@/shared/api', () => {
  const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return { api: {
    assets: { uploadAttachment },
    providers: {
      steerSession, skills: () => ok({ skills: [] }),
      nativeQueue: (session: string) => ok({ data: { messages: [...(native.get(session) ?? [])] } }),
      enqueueNativeMessage: (session: string, content: string, attachments: unknown[], id: string) => {
        const message = { id, content, attachments };
        native.set(session, [...(native.get(session) ?? []), message]);
        return ok({ data: { message } });
      },
      sendNativeQueuedMessage: async (session: string, id: string) => {
        const entry = native.get(session)?.find(item => item.id === id);
        const result = await steerSession(session, entry.content, entry.attachments, true);
        if (result.ok) native.set(session, native.get(session)!.filter(item => item.id !== id));
        return result;
      },
      deleteNativeQueuedMessage: (session: string, id: string) => {
        native.set(session, (native.get(session) ?? []).filter(item => item.id !== id));
        return ok({ data: { deleted: true } });
      },
    },
    user: { drafts: () => ok({ drafts: [] }), saveDraft: () => ok({}), deleteDraft: () => ok({}), preferences: () => ok({ preferences: {} }), savePreferences: () => ok({}) },
    commands: { list: () => ok({ commands: [] }) },
    files: { search: () => ok({ files: [] }) },
    getFiles: () => ok([]),
  } };
});

const PROJECT = { projectId: 'p', fullPath: '/tmp/p' } as Project;

function composer(provider: 'codex' | 'claude' | 'cursor' = 'codex', background = false, send?: (message: unknown) => Promise<void>) {
  const messages: ChatMessage[] = [];
  const view = renderHook(({ session }: { session: { id: string } }) => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: session, currentSessionId: session.id,
    provider, permissionMode: 'default', cyclePermissionMode: () => {},
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model', currentProviderEffort: 'medium',
    isLoading: send ? false : !background, processingSessions: background ? new Map([[session.id, { background: true, canInterrupt: false, statusText: 'Running background task', startedAt: Date.now() }]]) : undefined, canAbortSession: true, tokenBudget: null,
    sendMessage: send ?? (() => { throw new Error('Steering must not start a second turn'); }),
    scrollToBottom: () => {}, addMessage: (message) => { messages.push(message as ChatMessage); },
    setIsUserScrolledUp: () => {}, setPendingPermissionRequests: () => {},
  }), { initialProps: { session: { id: 'session-a' } } });
  return { view, messages };
}

beforeEach(() => {
  localStorage.clear(); resetChatDrafts(); native.clear(); steerSession.mockReset(); uploadAttachment.mockReset();
});

async function queue(view: ReturnType<typeof composer>['view'], content: string) {
  await act(async () => { view.result.current.setInput(content); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
}

async function sendQueued(view: ReturnType<typeof composer>['view']) {
  const entry = view.result.current.nativeQueuedMessages[0];
  if (entry) await view.result.current.changeNativeQueuedMessage(entry, 'send');
  else await view.result.current.handleSteer();
}

test('successive queued messages append in the native queue instead of overwriting the previous message', async () => {
  const { view } = composer();
  await queue(view, 'first');
  await queue(view, 'second');
  assert.deepEqual(view.result.current.nativeQueuedMessages.map(entry => entry.content), ['first', 'second']);
  assert.equal(readQueuedMessage('session-a'), null, 'native inputs must not use the single draft slot');
  await act(async () => { await view.result.current.changeNativeQueuedMessage(view.result.current.nativeQueuedMessages[0], 'delete'); });
  assert.deepEqual(view.result.current.nativeQueuedMessages.map(entry => entry.content), ['second']);
  view.unmount();
});

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider} queued arrow waits for acknowledgement and preserves new composer text`, async () => {
    let acknowledge!: (result: unknown) => void;
    steerSession.mockReturnValue(new Promise((resolve) => { acknowledge = resolve; }));
    const { view, messages } = composer(provider);
    await queue(view, 'change direction');
    await act(async () => { view.result.current.setInput('next draft'); });
    let pending!: Promise<void>;
    act(() => { pending = sendQueued(view); });
    await waitFor(() => assert.equal(steerSession.mock.calls.length, 1));
    assert.equal(view.result.current.nativeQueuedMessages[0]?.content, 'change direction');
    await act(async () => {
      await sendQueued(view);
      acknowledge({ ok: true, json: async () => ({ data: { delivered: true } }) });
      await pending;
    });
    assert.equal(steerSession.mock.calls.length, 1);
    assert.deepEqual(steerSession.mock.calls[0], ['session-a', 'change direction', [], true]);
    assert.equal(view.result.current.queuedDraft, null);
    assert.equal(view.result.current.input, 'next draft');
    assert.equal(readDraftText('session-a'), 'next draft');
    assert.equal(messages.filter(message => message.type === 'user').length, 0, 'native consumption events own the user echo');
    view.unmount();
  });
}

test('an unconfirmed queued send retains the card paused and shows the error', async () => {
  steerSession.mockResolvedValue({ ok: false, json: async () => ({ error: { message: 'No active turn' } }) });
  const { view, messages } = composer();
  await queue(view, 'do not lose this');
  await act(async () => { await sendQueued(view); });
  assert.equal(view.result.current.nativeQueuedMessages[0]?.content, 'do not lose this');
  assert.equal(view.result.current.input, 'do not lose this');
  assert.equal(messages.at(-1)?.content, 'No active turn');
  view.unmount();
});

test('a late queued acknowledgement preserves another session and its draft', async () => {
  let acknowledge!: (result: unknown) => void;
  steerSession.mockReturnValue(new Promise((resolve) => { acknowledge = resolve; }));
  const { view, messages } = composer();
  await queue(view, 'original');
  let pending!: Promise<void>;
  act(() => { pending = sendQueued(view); });
  await waitFor(() => assert.equal(steerSession.mock.calls.length, 1));
  await act(async () => { view.rerender({ session: { id: 'session-b' } }); });
  await act(async () => { view.result.current.setInput('new draft'); });
  await act(async () => {
    acknowledge({ ok: true, json: async () => ({ data: { delivered: true } }) });
    await pending;
  });
  assert.equal(view.result.current.input, 'new draft');
  assert.equal(readDraftText('session-b'), 'new draft');
  assert.equal(readQueuedMessage('session-a'), null);
  assert.equal(messages.filter((message) => message.type === 'user').length, 0);
  view.unmount();
});

test('Claude can send a queued card while background work remains', async () => {
  writeQueuedMessage('session-a', { content: 'keep the background job' });
  steerSession.mockResolvedValue({ ok: true, json: async () => ({ data: { delivered: true } }) });
  const { view } = composer('claude', true);
  assert.equal(view.result.current.canSteer, true);
  await act(async () => { await sendQueued(view); });
  assert.deepEqual(steerSession.mock.calls[0], ['session-a', 'keep the background job', [], true]);
  view.unmount();
});

test('providers without live input cannot send through the queued arrow', async () => {
  const { view } = composer('cursor');
  assert.equal(view.result.current.canSteer, false);
  await queue(view, 'retain');
  await act(async () => { await sendQueued(view); });
  assert.equal(steerSession.mock.calls.length, 0);
  assert.equal(view.result.current.queuedDraft?.content, 'retain');
  view.unmount();
});

for (const outcome of ['accepted', 'rejected', 'switched', 'new-text']) {
  test(`ordinary send retains the draft until receipt: ${outcome}`, async () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const send = vi.fn(() => new Promise<void>((yes, no) => { resolve = yes; reject = no; }));
    const { view, messages } = composer('claude', false, send);
    await act(async () => { view.result.current.setInput('original'); });
    let pending!: Promise<void>;
    act(() => { pending = view.result.current.handleSubmit({ preventDefault() {} } as never); });
    assert.equal(view.result.current.input, 'original');
    assert.equal(view.result.current.isSending, true);
    assert.equal(messages.length, 0);
    await act(async () => {
      await view.result.current.handleSubmit({ preventDefault() {} } as never);
    });
    assert.equal(send.mock.calls.length, 1);
    if (outcome === 'switched') await act(async () => { view.rerender({ session: { id: 'session-b' } }); });
    if (outcome === 'switched' || outcome === 'new-text') {
      await act(async () => { view.result.current.setInput('new draft'); });
    }
    await act(async () => {
      if (outcome === 'rejected') reject(new Error('disconnected'));
      else resolve();
      await pending;
    });
    assert.equal(view.result.current.input, outcome === 'accepted' ? '' : outcome === 'rejected' ? 'original' : 'new draft');
    assert.equal(messages.filter(m => m.type === 'user').length, ['accepted', 'new-text'].includes(outcome) ? 1 : 0);
    assert.equal(view.result.current.isSending, false);
    view.unmount();
  });
}


for (const method of ['picker', 'drop'] as const) {
  test(`${method} adds a file to the composer and sends the uploaded descriptor`, async () => {
    const send = vi.fn(async () => {});
    const { view } = composer('claude', false, send);
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'size', { value: 22 * 1024 * 1024 });
    const attachment = { name: file.name, path: '/assets/notes.txt', mimeType: file.type, size: file.size };
    uploadAttachment.mockResolvedValue(attachment);
    const picker = render(<PromptInput {...view.result.current.getRootProps()}>
      <input {...view.result.current.getInputProps()} data-testid="file-input" />
    </PromptInput>);
    await act(async () => {
      if (method === 'picker') {
        fireEvent.change(picker.getByTestId('file-input'), { target: { files: [file] } });
      } else {
        fireEvent.drop(picker.container.querySelector('form')!, { dataTransfer: {
          files: [file], types: ['Files'], items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
        } });
      }
    });
    assert.equal(view.result.current.attachedFiles.length, 1);
    assert.equal(view.result.current.attachedFiles[0].name, 'notes.txt');
    await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
    assert.equal(uploadAttachment.mock.calls.length, 1);
    assert.equal(send.mock.calls.length, 1);
    assert.deepEqual((send.mock.calls as unknown as Array<[any]>)[0][0].options.attachments, [attachment]);
    assert.equal(view.result.current.attachedFiles.length, 0);
  });
}

test('oversized picker files produce a visible error instead of disappearing silently', async () => {
  const { view } = composer('claude', false, async () => {});
  const file = new File(['test'], 'large.zip');
  Object.defineProperty(file, 'size', { value: 101 * 1024 * 1024 });
  const picker = render(<PromptInput {...view.result.current.getRootProps()}>
    <input {...view.result.current.getInputProps()} data-testid="file-input" />
  </PromptInput>);
  await act(async () => { fireEvent.change(picker.getByTestId('file-input'), { target: { files: [file] } }); });
  assert.equal(view.result.current.attachedFiles.length, 0);
  assert.match(view.result.current.fileErrors.get(file.name) ?? '', /100MB/);
});

test('a failed upload preserves both attachment and input and enables retry', async () => {
  const send = vi.fn(async () => {});
  const { view, messages } = composer('claude', false, send);
  const file = new File(['hello'], 'notes.txt');
  uploadAttachment.mockRejectedValue(new Error('File upload timed out. Please retry.'));
  await act(async () => {
    view.result.current.setInput('read this');
    view.result.current.setAttachedFiles([file]);
  });
  uploadAttachment.mockRejectedValue(new Error('File upload timed out. Please retry.'));
  await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
  assert.equal(view.result.current.input, 'read this');
  assert.deepEqual(view.result.current.attachedFiles, [file]);
  assert.equal(view.result.current.isSending, false);
  assert.equal(send.mock.calls.length, 0);
  assert.match(view.result.current.attachmentUploadStates.get(file)?.error ?? '', /timed out/);
  assert.equal(messages.length, 0, 'upload failure stays on the attachment; nothing was submitted');
});


for (const rejected of [false, true]) {
  test(`live attachment send ${rejected ? 'retains the file on failure' : 'uploads and waits for acknowledgement'}`, async () => {
    const { view, messages } = composer('claude');
    const file = new File(['doc'], 'report.docx');
    const attachment = { name: file.name, path: '/assets/report.docx', size: file.size };
    uploadAttachment.mockResolvedValue(attachment);
    steerSession.mockResolvedValue({ ok: !rejected, json: async () => rejected ? { error: 'not received' } : { data: { delivered: true } } });
    const picker = render(<PromptInput {...view.result.current.getRootProps()}><input {...view.result.current.getInputProps()} data-testid="live-file" /></PromptInput>);
    await act(async () => fireEvent.change(picker.getByTestId('live-file'), { target: { files: [file] } }));
    await queue(view, '');
    await act(async () => { await sendQueued(view); });
    assert.deepEqual(steerSession.mock.calls[0], ['session-a', '', [attachment], true]);
    assert.equal(view.result.current.nativeQueuedMessages[0]?.attachments.length ?? 0, rejected ? 1 : 0);
    assert.equal(uploadAttachment.mock.calls.length, 1);
    if (rejected) assert.equal(messages[0].type, 'error');
    else assert.equal(messages.length, 0);
    picker.unmount(); view.unmount();
  });
}


test('pending attachment blocks click, keyboard and queue admission until upload succeeds', async () => {
  let finish!: (value: unknown) => void;
  uploadAttachment.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const send = vi.fn(async () => {});
  const { view, messages } = composer('claude', false, send);
  const file = new File(['bytes'], 'pending.txt');
  await act(async () => { view.result.current.setInput('read this'); view.result.current.setAttachedFiles([file]); });
  act(() => { uploadAttachment.mock.calls[0][3](100); });
  assert.equal(view.result.current.attachmentUploadStates.get(file)?.status, 'uploading', '100% transferred is not a server completion acknowledgement');
  await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
  assert.equal(send.mock.calls.length, 0);
  assert.equal(messages.length, 0);
  assert.equal(view.result.current.isSending, false);
  assert.equal(view.result.current.input, 'read this');
  assert.equal(view.result.current.queuedDraft, null);
  await act(async () => { finish({ name: file.name, path: '/assets/pending.txt', mimeType: 'text/plain' }); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
  assert.equal(send.mock.calls.length, 1);
  assert.equal(view.result.current.attachedFiles.length, 0);
});

test('an upload error remains unsent until explicit retry completes', async () => {
  uploadAttachment.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({name:'retry.txt',path:'/assets/retry.txt'});
  const send=vi.fn(async()=>{}); const {view}=composer('claude',false,send);
  const file=new File(['data'],'retry.txt');
  await act(async()=>{view.result.current.setAttachedFiles([file]);});
  await act(async()=>{await view.result.current.handleSubmit({preventDefault(){}} as never);});
  assert.equal(send.mock.calls.length,0);assert.equal(uploadAttachment.mock.calls.length,1);
  await act(async()=>{view.result.current.retryAttachmentUpload(file);});
  await act(async()=>{await view.result.current.handleSubmit({preventDefault(){}} as never);});
  assert.equal(send.mock.calls.length,1);assert.equal(uploadAttachment.mock.calls.length,2);
});
