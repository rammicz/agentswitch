// Synthetic OpenCode 2.x store from the pinned v2.4.1 bootstrap DDL (packages/core/src/database/schema.gen.ts,
// upstream 6f0514052a3c859894ad01bb14cc14dda1e44b96) plus its optional FTS5 session_search index. No 1.x tables.
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fixture as v1Fixture, id as v1Id } from './native.mjs';

export const v2Id = 'ses_v2main001';
const v2Tables = `
CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, vcs text, name text, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL,
  CONSTRAINT fk_session_message_session_id_session_v2_id_fk FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE);
CREATE TABLE session_part (message_id text NOT NULL, session_id text NOT NULL, ordinal integer NOT NULL, type text NOT NULL, call_id text, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL,
  CONSTRAINT session_part_pk PRIMARY KEY(message_id, ordinal),
  CONSTRAINT fk_session_part_message_id_session_message_id_fk FOREIGN KEY (message_id) REFERENCES session_message(id) ON DELETE CASCADE,
  CONSTRAINT fk_session_part_session_id_session_v2_id_fk FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE);
CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, fork_session_id text, fork_boundary text, slug text NOT NULL, directory text NOT NULL, path text, title text, version text NOT NULL,
  share_url text, summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL,
  tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL,
  revert text, permission text, agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_busy integer, time_idle integer, time_viewed integer, idle_outcome text,
  time_compacting integer, time_archived integer, time_suspended integer, resume_attempts integer DEFAULT 0 NOT NULL,
  CONSTRAINT fk_session_v2_project_id_project_id_fk FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE);
CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
CREATE INDEX session_part_session_message_idx ON session_part (session_id, message_id, ordinal);
CREATE TABLE blob (hash text PRIMARY KEY, data blob);
CREATE TABLE session_search_document (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL);
CREATE VIRTUAL TABLE session_search USING fts5(title, summary, user_text, assistant_text, content='', contentless_delete=1, tokenize='porter unicode61 remove_diacritics 2');
CREATE TRIGGER session_search_session_delete AFTER DELETE ON session_v2 BEGIN DELETE FROM session_search_document WHERE source_id = OLD.id; END;`;

/** Adds the 2.x tables and sessions to `db`. Messages and part rows are inserted out of order on purpose. */
function populate(db, cwd, { revert = null } = {}) {
  db.exec(v2Tables + `CREATE TABLE IF NOT EXISTS credential(value TEXT); CREATE TABLE IF NOT EXISTS account(access_token TEXT);`);
  db.prepare('INSERT INTO credential VALUES (?)').run('PRIVATE_CREDENTIAL');
  db.prepare('INSERT INTO blob VALUES (?,?)').run('sha', Buffer.from('PRIVATE_BLOB'));
  db.prepare('INSERT INTO project VALUES (?,?,?,?,?,?)').run('prj_1', cwd, 'git', 'p', 1, 1);
  const session = (sid, { title = null, version = '2.4.1', parent = null, fork = null, archived = null, updated = 1795255300000, revert: boundary = null } = {}) =>
    db.prepare('INSERT INTO session_v2 (id,project_id,parent_id,fork_session_id,slug,directory,title,version,revert,time_created,time_updated,time_archived) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(sid, 'prj_1', parent, fork, 'slug-' + sid, cwd, title, version, boundary && JSON.stringify(boundary), 1795255200000, updated, archived);
  const message = (sid, mid, type, seq, data) => db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(mid, sid, type, seq, seq, seq, JSON.stringify(data));
  const part = (sid, mid, ordinal, type, data) => db.prepare('INSERT INTO session_part VALUES (?,?,?,?,?,?,?,?)').run(mid, sid, ordinal, type, null, 1, 1, JSON.stringify(data));
  session(v2Id, { revert });
  message(v2Id, 'msg_a2', 'assistant', 7, { time: { created: 7 }, error: { type: 'api', message: 'boom', response: { body: 'PRIVATE_ERROR_BODY' } }, content: [{ type: 'text', text: 'Old inline answer' }] });
  message(v2Id, 'msg_u1', 'user', 1, { text: 'V2 public question', files: [{ data: 'PRIVATE_FILE_DATA' }] });
  message(v2Id, 'msg_a1', 'assistant', 2, { time: { created: 2, completed: 3 }, native: { secret: 'PRIVATE_NATIVE' }, content: [{ type: 'text', text: 'Inline after parts' }, { type: 'reasoning', text: 'PRIVATE_REASONING' }] });
  part(v2Id, 'msg_a1', 3, 'text', { text: 'Part three' });
  part(v2Id, 'msg_a1', 1, 'text', { text: 'Part one' });
  part(v2Id, 'msg_a1', 2, 'tool', { id: 'call_1', name: 'bash', state: { status: 'completed', input: { command: 'PRIVATE_INPUT' }, metadata: { secret: 'PRIVATE_METADATA' }, content: [{ type: 'text', text: 'Tool output' }, { type: 'file', uri: 'PRIVATE_FILE_URI' }] } });
  part(v2Id, 'msg_a1', 5, 'tool', { id: 'call_2', name: 'bash', state: { status: 'error', input: { command: 'PRIVATE_INPUT' }, error: { message: 'Tool failed', response: { body: 'PRIVATE_RESPONSE_BODY' } } } });
  part(v2Id, 'msg_a1', 6, 'tool', { id: 'call_3', name: 'bash', state: { status: 'streaming', input: { command: 'PRIVATE_STREAMING' } } });
  part(v2Id, 'msg_a1', 8, 'reasoning', { text: 'PRIVATE_REASONING_PART' });
  for (const [seq, type, data] of [[3, 'synthetic', { text: 'PRIVATE_SYNTHETIC' }], [4, 'system', { text: 'PRIVATE_SYSTEM' }], [5, 'shell', { command: 'PRIVATE_SHELL', output: 'PRIVATE_SHELL_OUTPUT' }], [6, 'compaction', { status: 'completed', summary: 'PRIVATE_COMPACTION' }], [10, 'model-switched', { model: 'PRIVATE_MODEL' }]])
    message(v2Id, `msg_x${seq}`, type, seq, data);
  message(v2Id, 'msg_u2', 'user', 8, { text: 'Latest question' });
  message(v2Id, 'msg_a3', 'assistant', 9, { time: { created: 9 }, content: [{ type: 'text', text: 'Streaming answer' }] });
  session('ses_v2child01', { title: 'Child', parent: v2Id });
  session('ses_v2archived1', { title: 'Archived', archived: 5 });
  session('ses_v2fork001', { title: 'Forked session', version: '1.19.6', fork: v2Id, updated: 1795255250000 });
  message('ses_v2fork001', 'msg_f1', 'user', 1, { text: 'Fork question' });
  return { session, message };
}

/** A fresh 2.x store: no session/message/part tables. */
export async function fixtureV2(path, cwd, options = {}) {
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try { populate(db, cwd, options); } finally { db.close(); }
  return path;
}

/** An upgraded 1.x store: the 1.x rows stay, 2.x copied the shared session under the same ID and added a later turn. */
export async function fixtureMixed(path, cwd) {
  await v1Fixture(path, cwd);
  const db = new DatabaseSync(path);
  try {
    db.exec('DROP TABLE session_message'); // loose_psylocke recreates session_message for session_v2.
    db.prepare('INSERT INTO session SELECT ?,directory,workspace_id,parent_id,?,version,time_created,time_updated-1,time_archived,revert FROM session WHERE id=?').run('ses_v1only001', 'V1 only session', v1Id);
    const { session, message } = populate(db, cwd);
    session(v1Id, { title: 'OpenCode synthetic', version: '1.19.6', updated: 1795255400000 });
    message(v1Id, 'msg_a', 'user', 1, { text: 'First public' });
    message(v1Id, 'msg_b', 'assistant', 2, { time: { created: 2, completed: 3 }, content: [{ type: 'text', text: 'OpenCode answer' }] });
    message(v1Id, 'msg_after', 'user', 3, { text: 'Post-upgrade turn' });
  } finally { db.close(); }
  return path;
}
