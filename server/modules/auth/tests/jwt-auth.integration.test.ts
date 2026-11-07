import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

const ORIGIN = 'https://cloudagent.example';

for (const legacyFlag of [true, false]) {
  test(`HTTP and WebSocket require JWT even with the legacy flag set to ${legacyFlag}`, { timeout: 30_000 }, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'jwt-auth-test-'));
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const child = fork(new URL(`./fixtures/jwt-auth-server.${extension}`, import.meta.url), [], {
      execArgv: ['--import', import.meta.resolve('tsx')],
      env: {
        ...process.env,
        NODE_ENV: 'test', DATABASE_PATH: path.join(directory, 'auth.db'),
        TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
        JWT_SECRET: 'fixture-only-jwt-secret-do-not-use-in-production',
        VITE_IS_PLATFORM: String(legacyFlag),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let errors = '';
    child.stderr?.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4000); });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
        try { await exited; } finally { clearTimeout(timeout); }
      }
      await rm(directory, { recursive: true, force: true });
    });
    const ready = await new Promise<{ port: number; token: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Auth fixture startup timed out: ${errors}`)), 10_000);
      child.once('message', (message: unknown) => {
        clearTimeout(timeout);
        if (typeof message === 'object' && message !== null && 'port' in message && 'token' in message
          && typeof message.port === 'number' && typeof message.token === 'string') {
          resolve({ port: message.port, token: message.token });
        } else reject(new Error('Invalid fixture response'));
      });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Auth fixture exited: ${errors}`)); });
    });

    const cases: Array<{ headers: Record<string, string>; token?: string; accepted: boolean }> = [
      { headers: {}, accepted: false },
      { headers: { origin: ORIGIN }, accepted: false },
      { headers: { authorization: `Bearer ${ready.token}`, origin: ORIGIN }, accepted: true },
      { headers: { authorization: `Bearer ${ready.token}` }, accepted: true },
      { headers: {}, token: ready.token, accepted: true },
      { headers: { authorization: 'Bearer invalid-token' }, accepted: false },
      { headers: { 'x-cloudcli-platform-token': 'obsolete-gateway-token' }, accepted: false },
    ];
    for (const { headers, token, accepted } of cases) {
      const response = await fetch(`http://127.0.0.1:${ready.port}/protected${token ? `?token=${token}` : ''}`, { headers });
      assert.equal(response.ok, accepted, `HTTP auth mismatch in legacyFlag=${legacyFlag}`);
      await response.text();
      const opened = await new Promise<boolean>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${ready.port}/shell${token ? `?token=${token}` : ''}`, {
          headers, handshakeTimeout: 3000,
        });
        socket.once('error', () => resolve(false));
        socket.once('unexpected-response', (_request, incoming) => {
          incoming.resume();
          socket.terminate();
          resolve(false);
        });
        socket.once('open', () => { socket.close(); resolve(true); });
      });
      assert.equal(opened, accepted, `WS auth mismatch in legacyFlag=${legacyFlag}`);
    }
  });
}
