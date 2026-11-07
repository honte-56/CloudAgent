import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { pwaBuild } from '../pwa-build.js';

const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const build = { id: 'test', assets: ['/assets/app-123.js', '/assets/app-123.css'], entries: ['/assets/app-123.js'] };
const origin = 'https://cloudagent.test';
const html = '<html><script src="/assets/app-123.js"></script></html>';
const reply = (body, type = 'text/html', status = 200) => new Response(body, { status, headers: { 'content-type': type } });

function worker({ manifest = build, network, storageUnavailable = false } = {}) {
  const handlers = new Map();
  const stores = new Map();
  const calls = [];
  const key = value => new URL(typeof value === 'string' ? value : value.url, origin).href;
  const caches = {
    async open(name) {
      if (storageUnavailable) throw new Error('Storage unavailable');
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(request) { return store.get(key(request))?.clone(); },
        async put(request, response) { store.set(key(request), response.clone()); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  runInNewContext(source.replace('const BUILD = null;', `const BUILD = ${JSON.stringify(manifest)};`), {
    self: { location: { origin }, addEventListener(type, handler) { handlers.set(type, handler); } },
    caches, URL, Response,
    async fetch(request) {
      const url = key(request);
      calls.push(url);
      if (network) return network(url);
      return url.endsWith('/index.html') ? reply(html) : reply('asset', 'application/javascript');
    },
  });
  function dispatch(type, request) {
    const pending = [];
    let response;
    handlers.get(type)({ request, waitUntil(promise) { pending.push(promise); }, respondWith(promise) { response = promise; } });
    return { response, done: Promise.all(pending) };
  }
  const navigate = (path = '/', extra = {}) => dispatch('fetch', {
    url: new URL(path, origin).href, method: 'GET', mode: 'navigate', cache: 'default', ...extra,
  });
  return { dispatch, navigate, caches, stores, calls };
}

test('reopening the app and deep links serves the installed shell without a network round trip', async () => {
  const app = worker();
  await app.dispatch('install').done;
  app.calls.length = 0;
  for (const path of ['/', '/session/abc', '/file?path=test.ts']) {
    assert.equal(await (await app.navigate(path).response).text(), html);
  }
  const asset = app.navigate('/assets/app-123.js', { mode: 'cors' });
  assert.equal(await (await asset.response).text(), 'asset');
  await asset.done;
  assert.deepEqual(app.calls, []);
});

test('explicit refresh uses server HTML; an offline refresh falls back to the installed shell', async () => {
  let offline = false;
  const app = worker({ network: url => {
    if (offline) throw new Error('Offline');
    return url.endsWith('/index.html') ? reply(html) : reply('latest', 'application/javascript');
  } });
  await app.dispatch('install').done;
  assert.equal(await (await app.navigate('/', { cache: 'reload' }).response).text(), 'latest');
  offline = true;
  assert.equal(await (await app.navigate('/', { cache: 'reload' }).response).text(), html);
});

test('API, socket, maintenance, other origins and non-GET requests are not intercepted', () => {
  const app = worker();
  for (const path of ['/api/projects', '/ws', '/shell', '/plugin-ws', '/clear-cache.html', '/api-docs.html', '/plugin/page', 'https://other.test/assets/a.js']) {
    assert.equal(app.navigate(path).response, undefined);
  }
  assert.equal(app.navigate('/assets/a.js', { method: 'POST' }).response, undefined);
  assert.equal(worker({ manifest: null }).navigate('/').response, undefined);
});

test('failed or mismatched deployments cannot install a broken shell', async () => {
  for (const response of [reply('missing', 'text/plain', 404), reply('<html>login</html>')]) {
    const app = worker({ network: () => response.clone() });
    await assert.rejects(app.dispatch('install').done);
    assert.equal(app.stores.size, 0);
  }
  const app = worker({ network: url => url.endsWith('/index.html') ? reply(html) : reply('missing', 'text/plain', 404) });
  await assert.rejects(app.dispatch('install').done);
  assert.equal(await (await app.caches.open('cloudagent-shell-test')).match('/index.html'), undefined);
});

test('asset errors and HTML fallback responses never poison the asset cache', async () => {
  for (const response of [reply('missing', 'text/plain', 404), reply('<html>fallback</html>')]) {
    const app = worker({ network: () => response.clone() });
    const event = app.navigate('/assets/missing.js', { mode: 'cors' });
    await event.response;
    await event.done;
    assert.equal(await (await app.caches.open('cloudagent-shell-test')).match('/assets/missing.js'), undefined);
  }
});

test('cache eviction or unavailable storage falls back to the network', async () => {
  for (const storageUnavailable of [false, true]) {
    const app = worker({ storageUnavailable });
    assert.equal((await app.navigate('/').response).status, 200);
    const event = app.navigate('/assets/app-123.js', { mode: 'cors' });
    assert.equal((await event.response).status, 200);
    await event.done;
  }
});

test('activation removes only this app’s obsolete caches', async () => {
  const app = worker();
  for (const name of ['cloudagent-shell-old', 'cloudagent-shell-test', 'claude-ui-v2', 'another-app']) await app.caches.open(name);
  await app.dispatch('activate').done;
  assert.deepEqual(await app.caches.keys(), ['cloudagent-shell-test', 'another-app']);
});

test('production build emits a versioned worker; development source stays uncached', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloudagent-pwa-'));
  try {
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist/index.html'), html);
    const plugin = pwaBuild();
    plugin.configResolved({ root, publicDir: new URL('../../public', import.meta.url).pathname, build: { outDir: 'dist' } });
    const bundle = {
      'assets/app-123.js': { type: 'chunk', isEntry: true, fileName: 'assets/app-123.js' },
      'assets/lazy-123.js': { type: 'chunk', isEntry: false, fileName: 'assets/lazy-123.js' },
      'assets/app-123.css': { type: 'asset' },
      'index.html': { type: 'asset' },
    };
    plugin.writeBundle({}, bundle);
    const generated = readFileSync(join(root, 'dist/sw.js'), 'utf8');
    const manifest = JSON.parse(generated.match(/const BUILD = (.*);/)[1]);
    assert.deepEqual(manifest.entries, ['/assets/app-123.js']);
    assert.deepEqual(manifest.assets, ['/assets/app-123.css', '/assets/app-123.js', '/assets/lazy-123.js']);
    writeFileSync(join(root, 'dist/index.html'), `${html}<!-- new build -->`);
    plugin.writeBundle({}, bundle);
    assert.notEqual(readFileSync(join(root, 'dist/sw.js'), 'utf8'), generated);
    assert.ok(source.includes('const BUILD = null;'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
