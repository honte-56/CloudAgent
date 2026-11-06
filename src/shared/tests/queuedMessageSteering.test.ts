import assert from 'node:assert/strict';
import { beforeEach, afterEach, test, vi } from 'vitest';
import { readDraftText, readQueuedMessage, resetChatDrafts, steerQueuedMessage, writeDraftText, writeQueuedMessage } from '@/shared/chatDrafts';

const { saveDraft, steerSession, drafts } = vi.hoisted(() => ({ saveDraft: vi.fn(), steerSession: vi.fn(), drafts: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: {
  user: { saveDraft, drafts, deleteDraft: async () => ({ ok: true }) },
  providers: { steerSession },
} }));
const ok = { ok: true, json: async () => ({ data: { delivered: true } }) };

beforeEach(() => {
  resetChatDrafts();
  saveDraft.mockReset().mockResolvedValue({ ok: true });
  steerSession.mockReset().mockResolvedValue(ok);
  drafts.mockReset().mockResolvedValue({ ok: true, json: async () => ({ drafts: [] }) });
});
afterEach(() => { resetChatDrafts(); });

test('immediate sending waits for queue persistence and holds new typing until its claim finishes', async () => {
  let saved!: () => void;
  let delivered!: (value: unknown) => void;
  saveDraft.mockReturnValueOnce(new Promise(resolve => { saved = () => resolve({ ok: true }); }));
  steerSession.mockReturnValueOnce(new Promise(resolve => { delivered = resolve; }));
  writeQueuedMessage('a', { content: 'queued', attachments: [] });
  const sending = steerQueuedMessage('a');
  writeDraftText('a', 'new typing');
  await Promise.resolve();
  assert.equal(steerSession.mock.calls.length, 0);
  saved();
  await vi.waitFor(() => assert.equal(steerSession.mock.calls.length, 1));
  assert.equal(saveDraft.mock.calls.length, 1, 'no save may put a claimed message back');
  delivered(ok);
  await sending;
  await vi.waitFor(() => assert.equal(saveDraft.mock.calls.length, 2));
  assert.deepEqual(saveDraft.mock.calls[1], ['a', { text: 'new typing', queuedMessage: null }]);
  assert.equal(readDraftText('a'), 'new typing');
  assert.equal(readQueuedMessage('a'), null);
});

test('a queue already claimed by the dispatcher is removed without retrying it', async () => {
  steerSession.mockResolvedValue({ ok: false, json: async () => ({ error: { code: 'QUEUE_CHANGED', message: 'already sent' } }) });
  writeQueuedMessage('a', { content: 'queued' });
  await assert.rejects(steerQueuedMessage('a'), /already sent/);
  assert.equal(steerSession.mock.calls.length, 1);
  assert.equal(readQueuedMessage('a'), null);
});

test('a lost receipt preserves a paused card instead of automatically sending again', async () => {
  steerSession.mockRejectedValue(new Error('connection lost'));
  writeQueuedMessage('a', { content: 'queued' });
  await assert.rejects(steerQueuedMessage('a'), /connection lost/);
  assert.equal(readQueuedMessage('a')?.content, 'queued');
  assert.equal(readQueuedMessage('a')?.deliveryError, 'connection lost');
});

test('a stalled persistence chain releases the card and never injects later', async () => {
  vi.useFakeTimers();
  let finishSave!: (value: unknown) => void;
  saveDraft.mockReturnValueOnce(new Promise(resolve => { finishSave = resolve; }));
  try {
    writeQueuedMessage('a', { content: 'queued' });
    const rejection = assert.rejects(steerQueuedMessage('a'), /保存确认超时/);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    assert.match(readQueuedMessage('a')?.deliveryError ?? '', /超时/);
    finishSave({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(steerSession.mock.calls.length, 0, 'a late save must not trigger a send after timeout');
  } finally {
    vi.useRealTimers();
  }
});
