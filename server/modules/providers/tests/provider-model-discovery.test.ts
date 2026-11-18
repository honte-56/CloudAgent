import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderModelDiscovery } from '@/modules/providers/services/provider-model-discovery.service.js';

const catalog = (id: string) => ({ OPTIONS: [{ value: id, label: id }], DEFAULT: id });

test('reads lazily, coalesces requests, caches for five minutes and supports forced refresh', async () => {
  let now = 0;
  let calls = 0;
  const discover = createProviderModelDiscovery(() => now);
  const read = async () => { calls++; return catalog(`model-${calls}`); };
  assert.equal(calls, 0);
  const [a, b] = await Promise.all([discover('codex', read), discover('codex', read, true)]);
  assert.equal(calls, 1);
  assert.equal(a.DEFAULT, b.DEFAULT);
  a.OPTIONS.length = 0;
  assert.equal((await discover('codex', read)).OPTIONS.length, 1);
  now = 299_999;
  await discover('codex', read);
  assert.equal(calls, 1);
  now = 300_000;
  assert.equal((await discover('codex', read)).DEFAULT, 'model-2');
  assert.equal((await discover('codex', read, true)).DEFAULT, 'model-3');
  await discover('claude', read);
  assert.equal(calls, 4);
});

test('failed refresh preserves only real CLI results, marks them stale and backs off retries', async () => {
  let now = 0;
  let failing = false;
  let calls = 0;
  const discover = createProviderModelDiscovery(() => now);
  const read = async () => { calls++; if (failing) throw new Error('offline'); return catalog('native'); };
  const first = await discover('claude', read);
  failing = true;
  now = 300_000;
  const stale = await discover('claude', read);
  assert.equal(stale.DEFAULT, 'native');
  assert.deepEqual(stale.DISCOVERY, { status: 'stale', updatedAt: first.DISCOVERY?.updatedAt });
  await discover('claude', read);
  assert.equal(calls, 2);
  now += 30_000;
  await discover('claude', read);
  assert.equal(calls, 3);
  failing = false;
  assert.equal((await discover('claude', read, true)).DISCOVERY?.status, 'ready');
});

test('initial errors and empty lists expose no invented model choices and can be retried', async () => {
  const discover = createProviderModelDiscovery();
  for (const provider of ['claude', 'codex'] as const) {
    const failed = await discover(provider, async () => { throw new Error('missing CLI'); });
    assert.deepEqual(failed.OPTIONS, []);
    assert.equal(failed.DISCOVERY?.status, 'unavailable');
    assert.equal((await discover(provider, async () => catalog('native'), true)).DISCOVERY?.status, 'ready');
    assert.equal((await discover(provider, async () => ({ OPTIONS: [], DEFAULT: '' }), true)).DISCOVERY?.status, 'stale');
    assert.equal((await discover(provider, async () => catalog('recovered'), true)).DEFAULT, 'recovered');
  }
});
