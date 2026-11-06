import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-mapping-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('disk-discovered sessions are keyed by the provider id for both columns', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('provider-abc', 'claude', '/workspace/demo', 'From Disk');

    const row = sessionsDb.getSessionById('provider-abc');
    assert.equal(row?.session_id, 'provider-abc');
    assert.equal(row?.provider_session_id, 'provider-abc');

    const byProviderId = sessionsDb.getSessionByProviderSessionId('provider-abc');
    assert.equal(byProviderId?.session_id, 'provider-abc');
  });
});

test('app sessions get the provider id assigned without creating a duplicate row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-id-1', 'claude', '/workspace/demo', 'Initial CloudAgent message');
    sessionsDb.assignProviderSessionId('app-id-1', 'provider-xyz');

    // A later synchronizer pass that discovers the transcript on disk must
    // update the app row in place instead of inserting a provider-keyed row.
    const returnedId = sessionsDb.createSession(
      'provider-xyz',
      'claude',
      '/workspace/demo',
      'Synced Name',
      undefined,
      undefined,
      '/fake/path/provider-xyz.jsonl',
    );

    assert.equal(returnedId, 'app-id-1');
    assert.equal(sessionsDb.getAllSessions().length, 1);

    const row = sessionsDb.getSessionById('app-id-1');
    assert.equal(row?.provider_session_id, 'provider-xyz');
    assert.equal(row?.jsonl_path, '/fake/path/provider-xyz.jsonl');
    assert.equal(row?.custom_name, 'Initial CloudAgent message');
  });
});

test('assignProviderSessionId merges a watcher-created duplicate into the app row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-id-2', 'codex', '/workspace/demo');

    // Simulate the race: the filesystem watcher indexed the provider
    // transcript before the runtime announced its session id to the gateway.
    sessionsDb.createSession(
      'provider-race',
      'codex',
      '/workspace/demo',
      'Watcher Name',
      undefined,
      undefined,
      '/fake/provider-race.jsonl',
    );
    assert.equal(sessionsDb.getAllSessions().length, 2);

    sessionsDb.assignProviderSessionId('app-id-2', 'provider-race');

    const rows = sessionsDb.getAllSessions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.session_id, 'app-id-2');
    assert.equal(rows[0]?.provider_session_id, 'provider-race');
    // Transcript path and name from the duplicate are adopted.
    assert.equal(rows[0]?.jsonl_path, '/fake/provider-race.jsonl');
    assert.equal(rows[0]?.custom_name, 'Watcher Name');
  });
});

test('legacy provider-keyed rows stay resolvable through both lookups', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('legacy-1', 'opencode', '/workspace/demo');

    assert.equal(sessionsDb.getSessionById('legacy-1')?.provider, 'opencode');
    assert.equal(sessionsDb.getSessionByProviderSessionId('legacy-1')?.session_id, 'legacy-1');
  });
});

test('native id changes merge the new transcript, preserve pending work, and prevent old transcript resurrection', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'test', 'unused')").run();
    sessionsDb.createAppSession('app-replay', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-replay', 'old-native');
    sessionsDb.createSession('old-native', 'claude', '/workspace/demo', 'Original', undefined, undefined, '/old.jsonl');
    sessionsDb.createSession('new-native', 'claude', '/workspace/demo', 'New', undefined, undefined, '/new.jsonl');
    const queued = JSON.stringify({ text: 'continue', attachments: [{ path: '/uploads/keep.txt' }] });
    db.prepare('INSERT INTO session_drafts (user_id,draft_scope,draft_text,queued_message) VALUES (1,?,?,?)').run('new-native', 'unsent', queued);
    db.prepare("INSERT INTO scheduled_messages (id,user_id,session_id,content,scheduled_for) VALUES ('later',1,'new-native','later','2099-01-01')").run();
    sessionsDb.assignProviderSessionId('app-replay', 'new-native');
    const row = sessionsDb.getSessionById('app-replay');
    assert.equal(row?.provider_session_id, 'new-native');
    assert.equal(row?.jsonl_path, '/new.jsonl');
    assert.equal(sessionsDb.getSessionById('new-native'), null);
    assert.deepEqual(sessionsDb.getSupersededTranscriptPaths('app-replay'), ['/old.jsonl']);
    assert.equal(sessionsDb.createSession('old-native', 'claude', '/workspace/demo', 'stale', undefined, undefined, '/old.jsonl'), 'app-replay');
    assert.equal(sessionsDb.getAllSessions().length, 1);
    assert.equal(sessionsDb.getSessionById('app-replay')?.jsonl_path, '/new.jsonl');
    assert.deepEqual(db.prepare('SELECT draft_text, queued_message FROM session_drafts WHERE draft_scope=?').get('app-replay'), { draft_text: 'unsent', queued_message: queued });
    assert.deepEqual(db.prepare("SELECT session_id FROM scheduled_messages WHERE id='later'").get(), { session_id: 'app-replay' });
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  });
});

test('id change before watcher arrival clears the old transcript and later indexes into the same app row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-race', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-race', 'old-id');
    sessionsDb.createSession('old-id', 'claude', '/workspace/demo', undefined, undefined, undefined, '/old.jsonl');
    sessionsDb.assignProviderSessionId('app-race', 'next-id');
    assert.equal(sessionsDb.getSessionById('app-race')?.jsonl_path, null);
    assert.equal(sessionsDb.createSession('next-id', 'claude', '/workspace/demo', undefined, undefined, undefined, '/next.jsonl'), 'app-race');
    assert.equal(sessionsDb.getSessionById('app-race')?.jsonl_path, '/next.jsonl');
    assert.equal(sessionsDb.getAllSessions().length, 1);
  });
});

test('mapping refuses to absorb a different app session or discard conflicting unsent drafts', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-owner', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-owner', 'native-owned');
    sessionsDb.createAppSession('another-app', 'claude', '/workspace/demo');
    assert.throws(() => sessionsDb.assignProviderSessionId('another-app', 'native-owned'), /another app session/);
    const db = getConnection();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'test', 'unused')").run();
    sessionsDb.createSession('indexed', 'claude', '/workspace/demo');
    db.prepare("INSERT INTO session_drafts (user_id,draft_scope,draft_text) VALUES (1,'app-owner','draft one'),(1,'indexed','draft two')").run();
    assert.throws(() => sessionsDb.assignProviderSessionId('app-owner', 'indexed'), /unsent messages/);
    assert.equal(sessionsDb.getSessionById('app-owner')?.provider_session_id, 'native-owned');
    assert.ok(sessionsDb.getSessionById('indexed'));
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session_drafts').get() as { n: number }).n, 2);
  });
});
