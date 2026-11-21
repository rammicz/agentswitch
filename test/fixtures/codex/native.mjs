// Synthetic records derived from the pinned official schema; never captured history.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export const stamp = '2026-11-20T10:00:00.000Z';
export const ids = Array.from({length: 12}, (_, i) => `019a0000-0000-7000-8000-${String(i + 1).padStart(12, '0')}`);
export const line = (type, payload, ordinal) => ({timestamp: stamp, ...(ordinal === undefined ? {} : {ordinal}), type, payload});
export const header = (id, cwd, extra = {}) => ({id, session_id: id, timestamp: stamp, cwd, originator: 'synthetic-fixture', cli_version: '0.171.0', history_mode: 'paginated', ...extra});
export const completed = (type, id, text, ordinal, extra = {}) => line('event_msg', {type:'item_completed', thread_id: ids[0], turn_id:'turn-1', item:{type,id,...(type === 'UserMessage' ? {content:[{type:'text',text}]} : type === 'AgentMessage' ? {content:[{type:'Text',text}]} : {aggregated_output:text,status:'completed'}),...extra}}, ordinal);
export function rollout(cwd, id = ids[0], records = [], extra = {}) {
  const base = extra.history_base?.end_ordinal_exclusive ?? 0;
  return [line('session_meta',header(id,cwd,extra),base), ...records];
}
export const encode = records => Buffer.from(records.map(r => JSON.stringify(r)).join('\n') + '\n');
export async function writeRollout(root, records, {archive = false, rolloutId, date = '2026-11-20T10-00-00'} = {}) {
  const id = records[0].payload.id;
  const folder = join(root,archive ? 'archived_sessions' : 'sessions/2026/11/20');
  await mkdir(folder,{recursive:true});
  const path = join(folder,`rollout-${date}-${id}${rolloutId ? `_${rolloutId}` : ''}.jsonl`);
  await writeFile(path,encode(records));
  return path;
}
export function schema(db) {
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, name TEXT, preview TEXT, recency_at INTEGER)');
}
export function row(db,id,path,cwd,name = 'Named session') {
  db.prepare('INSERT OR REPLACE INTO threads VALUES (?,?,?,?,?,?,?,?,?)').run(id,path,1795168800000,1795255200000,cwd,'Fallback title',name,'Preview',1795255200000);
}
