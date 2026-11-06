import assert from 'node:assert/strict';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { Project } from '@/shared/types';

const { steerSession, uploadAttachment, enqueueNativeMessage } = vi.hoisted(() => ({ steerSession: vi.fn(), uploadAttachment: vi.fn(), enqueueNativeMessage: vi.fn() }));
vi.mock('@/shared/api', () => {
  const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return { api: {
    assets: { uploadAttachment },
    providers: { enqueueNativeMessage, nativeQueue: () => ok({ data: { messages: [] } }), steerSession, skills: () => ok({ skills: [] }) },
    user: { drafts: () => ok({ drafts: [] }), saveDraft: () => ok({}), deleteDraft: () => ok({}), preferences: () => ok({ preferences: {} }), savePreferences: () => ok({}) },
    commands: { list: () => ok({ commands: [] }) },
    files: { search: () => ok({ files: [] }) },
    getFiles: () => ok([]),
  } };
});

const PROJECT = { projectId: 'p', fullPath: '/tmp/p' } as Project;
function composer(isLoading = false) {
  const sendMessage = vi.fn();
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT, selectedSession: { id: 'paste-session' }, currentSessionId: 'paste-session',
    provider: 'claude', permissionMode: 'default', cyclePermissionMode() {},
    resolvePermissionModeForProvider: () => 'default', currentProviderModel: 'test', currentProviderEffort: 'medium',
    isLoading, canAbortSession: isLoading, tokenBudget: null, sendMessage,
    scrollToBottom() {}, addMessage() {}, setIsUserScrolledUp() {}, setPendingPermissionRequests() {},
  }));
  return { view, sendMessage };
}
function paste(text: string, images: File[] = []) {
  return { preventDefault: vi.fn(), clipboardData: {
    items: images.map(file => ({ type: file.type, getAsFile: () => file })), files: [],
    getData: (type: string) => type === 'text/plain' ? text : '',
  } };
}
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(file);
  });
}
beforeEach(() => {
  localStorage.clear(); resetChatDrafts(); uploadAttachment.mockReset(); steerSession.mockReset(); enqueueNativeMessage.mockReset();
  uploadAttachment.mockImplementation(async (file: File) => ({ path: '/assets/' + file.name, name: file.name }));
  enqueueNativeMessage.mockResolvedValue({ ok: true, json: async () => ({ data: { message: { id: 'native-1', content: '', attachments: [] } } }) });
});

for (const text of ['中'.repeat(1999), '😀'.repeat(1999), 'a\n'.repeat(999)]) {
  test(`short paste stays native (${text.length} UTF-16 units)`, async () => {
    const { view } = composer();
    const event = paste(text);
    await act(async () => view.result.current.handlePaste(event as never));
    assert.equal(event.preventDefault.mock.calls.length, 0);
    assert.equal(view.result.current.attachedFiles.length, 0);
    view.unmount();
  });
}

for (const text of ['中'.repeat(2000), '😀'.repeat(2000), ' \n中文 abc\r\n'.repeat(300)]) {
  test(`long paste preserves exact UTF-8 content (${text.length} UTF-16 units)`, async () => {
    const { view, sendMessage } = composer();
    await act(async () => view.result.current.setInput('请分析附件'));
    const event = paste(text);
    await act(async () => view.result.current.handlePaste(event as never));
    const [file] = view.result.current.attachedFiles;
    assert.equal(event.preventDefault.mock.calls.length, 1);
    assert.match(file.name, /^pasted-text-.*\.txt$/);
    assert.equal(file.type, 'text/plain;charset=utf-8');
    assert.equal(await readText(file), text);
    assert.equal(view.result.current.input, '请分析附件');
    assert.equal(uploadAttachment.mock.calls.length, 1);
    assert.equal(sendMessage.mock.calls.length, 0);
    view.unmount();
  });
}

test('full attachment list falls back to native paste without losing text', async () => {
  const { view } = composer();
  await act(async () => view.result.current.setAttachedFiles(Array.from({ length: 10 }, (_, i) => new File(['x'], `${i}.txt`))));
  const event = paste('x'.repeat(2000));
  await act(async () => view.result.current.handlePaste(event as never));
  assert.equal(event.preventDefault.mock.calls.length, 0);
  assert.equal(view.result.current.attachedFiles.length, 10);
  assert.deepEqual([...view.result.current.fileErrors.values()], ['Too many files (max 10 attachments)']);
  view.unmount();
});

test('image paste still attaches images alongside long text and gives each TXT a unique name', async () => {
  const { view } = composer();
  const image = new File(['png'], 'image.png', { type: 'image/png' });
  await act(async () => view.result.current.handlePaste(paste('x'.repeat(2000), [image]) as never));
  await act(async () => view.result.current.handlePaste(paste('x'.repeat(2000)) as never));
  const files = view.result.current.attachedFiles;
  assert.equal(files.length, 3);
  assert.equal(files[0], image);
  assert.notEqual(files[1].name, files[2].name);
  view.unmount();
});

for (const busy of [false, true]) {
  test(`TXT uploads on paste and reuses the descriptor for ${busy ? 'queue' : 'send'}`, async () => {
    const attachment = { name: 'paste.txt', path: '/tmp/paste.txt', mimeType: 'text/plain' };
    uploadAttachment.mockResolvedValue(attachment);
    const { view, sendMessage } = composer(busy);
    await act(async () => view.result.current.handlePaste(paste('中'.repeat(2000)) as never));
    await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
    assert.equal(uploadAttachment.mock.calls.length, 1);
    const file = uploadAttachment.mock.calls[0][0] as File;
    assert.equal(await readText(file), '中'.repeat(2000));
    if (busy) {
      assert.deepEqual(enqueueNativeMessage.mock.calls[0].slice(0, 3), ['paste-session', '', [attachment]]);
      assert.equal(sendMessage.mock.calls.filter(([message]) => message.type === 'chat.send').length, 0);
    } else {
      const sends = sendMessage.mock.calls.filter(([message]) => message.type === 'chat.send');
      assert.equal(sends.length, 1);
      assert.deepEqual(sends[0][0].options.attachments, [attachment]);
    }
    view.unmount();
  });
}
