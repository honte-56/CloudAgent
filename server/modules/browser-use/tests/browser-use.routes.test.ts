import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';

import browserUseRoutes from '@/modules/browser-use/browser-use.routes.js';
import { browserUseService } from '@/modules/browser-use/browser-use.service.js';

test('browser input routes validate input before dispatching a click, text or key', async (t) => {
  const calls: Array<{ sessionId: string; input: Parameters<typeof browserUseService.userInput>[1] }> = [];
  t.mock.method(browserUseService, 'userInput', async (sessionId: string, input: Parameters<typeof browserUseService.userInput>[1]) => {
    calls.push({ sessionId, input });
    return { id: sessionId, lastAction: `user_${input.type}` };
  });
  const app = express();
  app.use(express.json());
  app.use('/browser', browserUseRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/browser/sessions/session-1/input`;
  const send = (body: unknown) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    for (const invalid of [null, {}, { type: 'click', x: '12', y: 1 }, { type: 'click', x: null, y: 1 },
      { type: 'text', text: '' }, { type: 'text', text: 'x'.repeat(2001) }, { type: 'key', key: '' }]) {
      assert.equal((await send(invalid)).status, 400);
    }
    assert.equal(calls.length, 0);
    for (const input of [{ type: 'click', x: 25, y: 50 }, { type: 'text', text: '测试 input' }, { type: 'key', key: 'Enter' }]) {
      const response = await send(input);
      assert.equal(response.status, 200);
      assert.deepEqual(calls.at(-1), { sessionId: 'session-1', input });
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
