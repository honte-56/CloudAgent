import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';

test('request parsing rejects compressed input without crashing the server', { timeout: 30_000 }, async (t) => {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const child = fork(new URL(`./fixtures/request-parsing-server.${extension}`, import.meta.url), [], {
    execArgv: ['--import', import.meta.resolve('tsx')],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr?.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4000); });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const forceKill = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(forceKill); }
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Parser fixture did not start: ${errors}`)), 10_000);
    child.once('message', (message: unknown) => {
      clearTimeout(timeout);
      if (typeof message === 'object' && message !== null && 'port' in message && typeof message.port === 'number') {
        resolve(message.port);
      } else reject(new Error('Invalid parser fixture response'));
    });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Parser fixture exited: ${errors}`)); });
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  async function checkHealthy() {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200, errors);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.equal(child.exitCode, null, errors);
  }

  for (const contentType of ['application/json', 'application/x-www-form-urlencoded']) {
    for (const [encoding, compress] of [
      ['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync],
    ] as const) {
      await t.test(`${contentType}: ${encoding} with trailing bytes is refused before authentication`, async () => {
        const payload = contentType === 'application/json' ? '{"message":"hello"}' : 'message=hello';
        const compressed = compress(Buffer.from(payload));
        // Separate writes also exercise the streaming request path. No large
        // payload or load is needed to cover the decompressor crash boundary.
        const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
          const outgoing = request(`${baseUrl}/protected`, {
            method: 'POST',
            headers: { 'Content-Type': contentType, 'Content-Encoding': encoding },
          }, (incoming) => {
            let body = '';
            incoming.setEncoding('utf8');
            incoming.on('data', (chunk: string) => { body += chunk; });
            incoming.on('error', reject);
            incoming.on('end', () => resolve({ status: incoming.statusCode, body }));
          });
          outgoing.on('error', reject);
          outgoing.setTimeout(3000, () => outgoing.destroy(new Error('Parser response timed out')));
          outgoing.write(compressed);
          setImmediate(() => outgoing.end(Buffer.from('invalid trailing bytes')));
        });
        assert.equal(result.status, 415, errors);
        assert.equal(JSON.parse(result.body).error.code, 'UNSUPPORTED_REQUEST_ENCODING');
        await checkHealthy();
      });
    }
  }

  await t.test('uncompressed JSON and vendor JSON preserve Unicode and nested fields', async () => {
    const body = { message: '你好', options: { stream: true }, files: ['a.txt'] };
    for (const contentType of ['application/json', 'application/vnd.cloudcli+json']) {
      const response = await fetch(`${baseUrl}/echo`, {
        method: 'POST', headers: { 'Content-Type': contentType, 'Content-Encoding': 'identity' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), body);
    }
  });

  await t.test('uncompressed URL-encoded forms still parse nested fields', async () => {
    const response = await fetch(`${baseUrl}/echo`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'message=hello&options[model]=test',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { message: 'hello', options: { model: 'test' } });
  });

  await t.test('multipart streams reach the upload parser unchanged, even with json in the boundary', async () => {
    const boundary = 'audit-json-boundary';
    const body = [
      `--${boundary}`, 'Content-Disposition: form-data; name="field"', '', 'hello',
      `--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="sample.txt"',
      'Content-Type: text/plain', '', 'file contents', `--${boundary}--`, '',
    ].join('\r\n');
    const response = await fetch(`${baseUrl}/upload`, {
      method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { field: 'hello', file: 'file contents' });
  });

  await t.test('invalid JSON returns 400 without reflecting submitted credentials', async () => {
    const response = await fetch(`${baseUrl}/echo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"fixture-only",',
    });
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.equal(JSON.parse(body).error.code, 'INVALID_REQUEST_BODY');
    assert.doesNotMatch(body + errors, /fixture-only/);
    await checkHealthy();
  });

  await t.test('requests over the existing 50 MiB limit return 413', async () => {
    const response = await fetch(`${baseUrl}/echo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: Buffer.alloc(50 * 1024 * 1024 + 1, ' '),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), {
      success: false,
      error: { code: 'REQUEST_BODY_TOO_LARGE', message: 'Request body exceeds the parsing limits.' },
    });
    await checkHealthy();
  });

  await t.test('normal requests still reach authentication and unknown routes', async () => {
    for (const [route, status] of [['/protected', 401], ['/unknown', 404]] as const) {
      const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(response.status, status);
      await response.text();
    }
    await checkHealthy();
  });
});
