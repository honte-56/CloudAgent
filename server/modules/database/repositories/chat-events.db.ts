import { getConnection } from '@/modules/database/connection.js';
import type { NormalizedMessage } from '@/shared/types.js';

const initialized = new WeakSet<object>();
function connection() {
  const db = getConnection();
  if (!initialized.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_event_cursors(session_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chat_events(session_id TEXT NOT NULL, event_key TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session_id,event_key));
      CREATE INDEX IF NOT EXISTS chat_events_sequence ON chat_events(session_id,seq);
      CREATE INDEX IF NOT EXISTS chat_events_age ON chat_events(created_at);`);
    initialized.add(db);
  }
  return db;
}

/** WebSocket delivery journal: durable session cursors and bounded replay, independent of provider process lifetimes. */
export const chatEventsDb = {
  cursor(sessionId: string): number {
    return (connection().prepare('SELECT seq FROM chat_event_cursors WHERE session_id=?').get(sessionId) as {seq:number}|undefined)?.seq ?? 0;
  },
  revision(sessionId: string): number {
    return (connection().prepare('SELECT revision FROM chat_event_cursors WHERE session_id=?').get(sessionId) as {revision:number}|undefined)?.revision ?? 0;
  },
  append(sessionId: string, message: NormalizedMessage): NormalizedMessage {
    const db = connection();
    return db.transaction(() => {
      const row = db.prepare('INSERT INTO chat_event_cursors(session_id,seq) VALUES (?,1) ON CONFLICT(session_id) DO UPDATE SET seq=seq+1 RETURNING seq').get(sessionId) as {seq:number};
      const event = { ...message, sessionId, seq: row.seq };
      if (message.kind === 'history_truncated') {
        db.prepare('DELETE FROM chat_events WHERE session_id=?').run(sessionId);
        db.prepare('UPDATE chat_event_cursors SET revision=? WHERE session_id=?').run(row.seq,sessionId);
      }
      // Stream frames contain complete snapshots. Replacing their earlier frame
      // keeps replay bounded without ever replaying a suffix as a complete reply.
      const key = message.kind === 'stream_delta' && message.messageKey ? `stream:${message.messageKey}` : `event:${row.seq}`;
      db.prepare('INSERT INTO chat_events VALUES (?,?,?,?,?) ON CONFLICT(session_id,event_key) DO UPDATE SET seq=excluded.seq,payload=excluded.payload,created_at=excluded.created_at')
        .run(sessionId, key, row.seq, JSON.stringify(event), Date.now());
      if (row.seq % 128 === 1) {
        db.prepare('DELETE FROM chat_events WHERE created_at < ?').run(Date.now()-24*60*60*1000);
        db.prepare(`DELETE FROM chat_events WHERE session_id=? AND seq NOT IN
          (SELECT seq FROM chat_events WHERE session_id=? ORDER BY seq DESC LIMIT 2000)`).run(sessionId,sessionId);
        // Keep at most 16 MiB per session; a single large newest event is retained.
        db.prepare(`DELETE FROM chat_events WHERE session_id=? AND seq IN (
          SELECT seq FROM (SELECT seq, sum(length(payload)) OVER (ORDER BY seq DESC) AS bytes,
          row_number() OVER (ORDER BY seq DESC) AS n FROM chat_events WHERE session_id=?) WHERE bytes>16777216 AND n>1)`).run(sessionId,sessionId);
      }
      return event;
    })();
  },
  replay(sessionId: string, afterSeq: number): NormalizedMessage[] {
    return (connection().prepare('SELECT payload FROM chat_events WHERE session_id=? AND seq>? ORDER BY seq').all(sessionId,afterSeq) as {payload:string}[]).map(row=>JSON.parse(row.payload));
  },
};
