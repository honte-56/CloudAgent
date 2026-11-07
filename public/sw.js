// Replaced by the production build. The dev worker only handles Web Push.
const BUILD = null;
const CACHE_PREFIX = 'cloudagent-shell-';
const CACHE_NAME = BUILD ? `${CACHE_PREFIX}${BUILD.id}` : null;
const SHELL_URL = '/index.html';

function isCacheableAsset(response) {
  return response.ok && !response.redirected
    && !response.headers.get('content-type')?.includes('text/html');
}

self.addEventListener('install', event => {
  if (!BUILD) return;
  event.waitUntil((async () => {
    const response = await fetch(SHELL_URL, { cache: 'reload' });
    const html = await response.clone().text();
    // Reject login redirects, fallback documents and a shell from a different
    // deployment. An incomplete update must leave the working version active.
    if (!response.ok || response.redirected
      || !response.headers.get('content-type')?.includes('text/html')
      || !BUILD.entries.every(entry => html.includes(entry))) {
      throw new Error('App shell does not match this service worker build');
    }
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(BUILD.assets.map(async url => {
      // Hashed URLs can reuse the HTTP cache populated by the first page load.
      const asset = await fetch(url);
      if (!isCacheableAsset(asset)) throw new Error(`Unable to cache ${url}`);
      await cache.put(url, asset);
    }));
    await cache.put(SHELL_URL, response);
  })());
  // Let the new version wait until existing windows close. Forcing activation
  // could delete assets still needed by an open chat or editor.
});

self.addEventListener('fetch', event => {
  if (!BUILD || event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Only known app routes use the shell. APIs, sockets, downloads, plugin
  // pages and maintenance pages such as clear-cache.html go straight through.
  const isAppRoute = url.pathname === '/' || url.pathname === '/index.html'
    || url.pathname === '/file' || /^\/session\/[^/]+\/?$/.test(url.pathname);
  if (event.request.mode === 'navigate' && isAppRoute) {
    event.respondWith((async () => {
      // An explicit refresh remains an escape hatch to the latest server HTML.
      if (event.request.cache === 'reload' || event.request.cache === 'no-cache') {
        try { return await fetch(event.request); } catch { /* Try the installed shell. */ }
      }
      try {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(SHELL_URL);
        if (cached) return cached;
      } catch { /* Storage can be unavailable or evicted. */ }
      return fetch(event.request);
    })());
    return;
  }

  // Build assets have content hashes; never store an error or an HTML fallback
  // at a script URL. Keep the cache write alive after sending the response.
  if (url.pathname.startsWith('/assets/')) {
    const resource = (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(event.request);
        if (cached) return { response: cached };
      } catch { /* Fetch normally if storage is unavailable. */ }
      const response = await fetch(event.request);
      return { response, copy: isCacheableAsset(response) ? response.clone() : null };
    })();
    event.respondWith(resource.then(result => result.response));
    event.waitUntil(resource.then(async ({ copy }) => {
      if (!copy) return;
      const cache = await caches.open(CACHE_NAME);
      await cache.put(event.request, copy);
    }).catch(() => {}));
  }
});

self.addEventListener('activate', event => {
  if (!BUILD) return;
  event.waitUntil(caches.keys().then(names => Promise.all(names
    .filter(name => name !== CACHE_NAME
      && (name.startsWith(CACHE_PREFIX) || /^claude-ui-v\d+$/.test(name)))
    .map(name => caches.delete(name)))));
});

// Push notification event
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'CloudAgent', body: event.data.text() };
  }

  const options = {
    body: payload.body || '',
    icon: '/logo-256.png',
    badge: '/logo-128.png',
    data: payload.data || {},
    tag: payload.data?.tag || `${payload.data?.sessionId || 'global'}:${payload.data?.code || 'default'}`,
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'CloudAgent', options)
  );
});

// Notification click event
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const provider = event.notification.data?.provider || null;
  const urlPath = sessionId ? `/session/${sessionId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          await client.focus();
          client.postMessage({
            type: 'notification:navigate',
            sessionId: sessionId || null,
            provider,
            urlPath
          });
          return;
        }
      }
      return self.clients.openWindow(urlPath);
    })
  );
});
