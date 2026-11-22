import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const evidence = JSON.parse(await readFile(new URL('./replay/evidence.json', import.meta.url), 'utf8'));
export const id = evidence.storage.profiles.find(p => p.kind === 'print').sessions.find(s => !s.wrapperAmbiguous).summary.conversation_id;
export const user = (text) => `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nPRIVATE_METADATA\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nPRIVATE_SETTINGS\n</USER_SETTINGS_CHANGE>`;
export async function fixture(root, cwd, options = {}) {
  const profile = evidence.storage.profiles.find(p => p.kind === (options.kind ?? 'print'));
  const sample = profile.sessions.find(s => !s.wrapperAmbiguous);
  const nativeId = options.nativeId ?? sample.summary.conversation_id;
  const row = { ...sample.summary, conversation_id: nativeId, workspace_uris: JSON.stringify([pathToFileURL(cwd).href]), ...options.row };
  const records = options.records ?? (await readFile(new URL('./replay/' + sample.transcriptFixture, import.meta.url), 'utf8')).trim().split('\n').map(JSON.parse);
  if (!options.records) {
    records[0].content = user(options.user ?? 'Agy public fixture NEEDLE_SECRET');
    records.at(-1).content = options.answer ?? 'Agy public answer';
    records.at(-1).thinking = 'PRIVATE_THINKING';
  }
  await mkdir(root, { recursive: true });
  const path = join(root, 'conversation_summaries.db');
  const db = new DatabaseSync(path);
  try {
    db.exec(profile.summarySchema.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));
    const keys = Object.keys(row);
    db.prepare(`INSERT OR REPLACE INTO conversation_summaries (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
  } finally { db.close(); }
  const history = join(root, 'brain', nativeId, '.system_generated', 'logs', 'transcript.jsonl');
  await mkdir(dirname(history), { recursive: true });
  await writeFile(history, records.map(row => JSON.stringify(row)).join('\n') + '\n');
  const cache = join(root, 'cache', 'last_conversations.json');
  await mkdir(dirname(cache), { recursive: true });
  let last = {};
  try { last = JSON.parse(await readFile(cache, 'utf8')); } catch {}
  await writeFile(cache, JSON.stringify({ ...last, [cwd]: nativeId }));
  return { nativeId, path, history, records, row, cache };
}
