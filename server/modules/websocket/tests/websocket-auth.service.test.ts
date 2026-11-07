import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';

import { verifyWebSocketClient } from '../services/websocket-auth.service.js';

test('websocket upgrades reject missing JWTs, including tokenless shell requests', (t) => {
  t.mock.method(console, 'log', () => {});
  for (const url of ['/shell', '/ws', '/desktop-notifications', '/plugin-ws/test']) {
    const req = { url, headers: { origin: 'https://evil.example' } } as IncomingMessage;
    let called = false;
    assert.equal(verifyWebSocketClient({ req, origin: 'https://evil.example', secure: true }, {
      authenticateWebSocket: (token) => {
        called = true;
        assert.equal(token, null);
        return null;
      },
    }), false);
    assert.equal(called, true);
    assert.equal('user' in req, false);
  }
});

test('verified JWT users receive their authenticated websocket context', (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => { logs.push(args); });
  for (const [url, headers, expectedToken] of [
    ['/ws?token=fixture-query-secret', {}, 'fixture-query-secret'],
    ['/ws', { authorization: 'Bearer fixture-header-secret' }, 'fixture-header-secret'],
  ] as const) {
    const req = { url, headers } as IncomingMessage;
    const user = { userId: 1, username: 'fixture' };
    assert.equal(verifyWebSocketClient({ req, origin: '', secure: false }, {
      authenticateWebSocket: (token) => {
        assert.equal(token, expectedToken);
        return user;
      },
    }), true);
    assert.deepEqual((req as IncomingMessage & { user: unknown }).user, user);
  }
  assert.doesNotMatch(JSON.stringify(logs), /fixture-(query|header)-secret/);
});
