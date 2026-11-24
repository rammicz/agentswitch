import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import type { SessionAdapter } from './adapters/index.js';
import type { AgentId, HistoryItem, Session, SessionQuery } from './domain.js';
import type { MatchExcerpt, SessionHit } from './tui/contracts.js';

export interface SearchSource {
  /** Stable identity for this provider's configured roots; change when the roots change. */
  sourceId: string;
  adapter: SessionAdapter;
}
export interface SearchIndexOptions {
  /** Dedicated private cache directory. No native source directory is ever inferred. */
  directory: string;
  /** One adapter per provider; its sourceId namespaces persisted data. */
  sources: readonly SearchSource[];
  /** Cap on cached message text in UTF-8 bytes, at most the 256 MiB default. */
  maxBytes?: number;
}
/** Each tool output item contributes at most its first 2 KiB to the index. */
export const maxToolTextBytes = 2048;
export const defaultMaxCacheBytes = 256 * 2 ** 20;
interface IndexedSession {
  session: Session;
  title: string;
  workspace: string;
  texts: string[];
  time: number;
}
interface StoredSession { updated: number | null; bytes: number; data: string }
const markerPrefix = 'agentswitch-search-v1\n';
const files = new Set(['owner', 'index.sqlite', 'index.sqlite-journal']);
const normalize = (text: string): string => text.toLowerCase();
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sourceKey = ({ sourceId, adapter }: SearchSource): string => JSON.stringify([adapter.id, sourceId]);
async function canonical(path: string): Promise<string> {
  try { return await realpath(resolve(path)); } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return resolve(path);
    throw error;
  }
}
function checkPrivate(info: Stats, directory: boolean): void {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
    throw new Error('Search cache must be a private, owned, regular file or directory (no symbolic links)');
  }
}
async function validateDirectory(directory: string): Promise<void> {
  checkPrivate(await lstat(directory), true);
  for (const file of await readdir(directory)) {
    if (!files.has(file)) throw new Error('Search cache directory must be empty or owned by agentswitch');
    checkPrivate(await lstat(join(directory, file)), false);
  }
}
function timestamp(value: string): number {
  if(value==='')return Number.NEGATIVE_INFINITY;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('Search session has an invalid timestamp');
  return time;
}
const toolPrefix = new Uint8Array(maxToolTextBytes);
const encoder = new TextEncoder();
/** The longest prefix of at most 2 KiB of UTF-8 that does not split a character. Encoding stops at the limit. */
const toolText = (text: string): string => text.slice(0, encoder.encodeInto(text, toolPrefix).read);
/** The public, bounded row for one session. `bytes` counts the message text that the cache cap applies to. */
function stored({ id, nativeId, agent, title, workspace, updatedAt, messages }: Session): StoredSession {
  const items = messages.map(({ id, role, status, text }) => ({ id, role, status, text: role === 'tool' ? toolText(text) : text }));
  const time = Date.parse(updatedAt);
  return { updated: Number.isFinite(time) ? time : null, bytes: items.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0),
    data: JSON.stringify({ id, nativeId, agent, title, workspace, updatedAt, messages: items }) };
}
// `updated` and `bytes` precede `data` so totals and eviction order never read the large text column.
const table = (name: string): string => `CREATE TABLE ${name} (source TEXT NOT NULL, native_id TEXT NOT NULL, updated INTEGER, bytes INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(source, native_id));`;
const ageIndex = 'CREATE INDEX sessions_age ON sessions(updated, bytes);';
function indexed(session: Session): IndexedSession {
  return { session, title: normalize(session.title), workspace: normalize(session.workspace), texts: session.messages.map((item) => normalize(item.text)), time: timestamp(session.updatedAt) };
}
function sortSessions(a: IndexedSession, b: IndexedSession): number {
  return b.time - a.time || compare(a.session.id, b.session.id) || compare(a.session.agent, b.session.agent) || compare(a.session.nativeId, b.session.nativeId);
}
/** A bounded excerpt containing the first literal match, without cutting surrogate pairs. */
function excerpt(text: string, needle: string): string {
  if (text.length <= 240) return text;
  const points = Array.from(text);
  // Case conversion may expand a character (for example İ). Map the folded offset back to code points.
  const offset = normalize(text).indexOf(needle);
  let folded = 0;
  let start = 0;
  while (start < points.length && folded < offset) folded += normalize(points[start++]!).length;
  let end = start;
  while (end < points.length && folded < offset + needle.length) folded += normalize(points[end++]!).length;
  const length = Math.min(240, Math.max(end - start, 80));
  const left = Math.max(0, start - Math.floor((240 - length) / 2));
  const right = Math.min(points.length, left + 240);
  return `${left > 0 ? '…' : ''}${points.slice(left, right).join('')}${right < points.length ? '…' : ''}`;
}

function match(row: IndexedSession, needle: string): SessionHit | undefined {
  const { session } = row;
  const matches: MatchExcerpt[] = [];
  if (needle) {
    if (row.title.includes(needle)) matches.push({ field: 'title', text: excerpt(session.title, needle) });
    else if (normalize(session.nativeId).includes(needle)) matches.push({ field: 'nativeId', text: session.nativeId });
    if (row.workspace.includes(needle)) matches.push({ field: 'workspace', text: excerpt(session.workspace, needle) });
    for (let i = 0; i < row.texts.length && matches.length < 3; i++) {
      if (!row.texts[i]!.includes(needle)) continue;
      const item = session.messages[i]!;
      matches.push({ field: 'message', itemId: item.id, role: item.role, text: excerpt(item.text, needle) });
    }
    if (!matches.length) return;
  }
  const { id, agent, nativeId, title, updatedAt, lastUsedAt, subagent } = session;
  return { id, agent, nativeId, title, workspace: session.workspace, updatedAt,
    ...(lastUsedAt ? {lastUsedAt} : {}), ...(subagent ? {subagent} : {}), matches };
}

export function matchSession(session: Session, query: string): SessionHit | undefined {
  return match(indexed(session), normalize(query.trim()));
}

/** Offline public-text index. Refresh is explicit; queries never call an adapter. */
export class SearchIndex {
  private rows: IndexedSession[] = [];
  private closed = false;
  private dataVersion: SQLOutputValue | undefined;
  private upsert: StatementSync | undefined;
  private operations: Promise<void> = Promise.resolve();
  private constructor(private readonly directory: string, private readonly sources: readonly SearchSource[], private readonly database: DatabaseSync, private readonly owner: string, private readonly identity: Stats, private readonly maxBytes: number) {}

  static async open(options: SearchIndexOptions, { load = true } = {}): Promise<SearchIndex> {
    const maxBytes = options.maxBytes ?? defaultMaxCacheBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > defaultMaxCacheBytes) throw new RangeError('Search cache limit must be between 1 byte and 256 MiB');
    const agents = new Set<AgentId>();
    for (const source of options.sources) {
      if (!source.sourceId || agents.has(source.adapter.id)) throw new Error('Register one nonempty source identity per provider');
      agents.add(source.adapter.id);
    }
    const directory = resolve(options.directory);
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await validateDirectory(directory);
    const entries = await readdir(directory);
    if (entries.length === 0) {
      await writeFile(join(directory, 'owner'), `${markerPrefix}${randomUUID()}\n`, { mode: 0o600, flag: 'wx' });
    }
    const owner = await readFile(join(directory, 'owner'), 'utf8');
    if (!owner.startsWith(markerPrefix)) throw new Error('Search cache is not owned by this index version; use a new dedicated directory');
    const filename = join(directory, 'index.sqlite');
    try {
      const handle = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.close();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await validateDirectory(directory);
    const database = new DatabaseSync(filename);
    try {
      database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY;');
      const version = () => database.prepare('PRAGMA user_version').get()?.user_version;
      const index = new SearchIndex(directory, options.sources.map((source) => ({ ...source })), database, owner, await lstat(filename), maxBytes);
      if (version() !== 2) {
        index.transaction(() => {
          const current = version();
          if (current === 0) database.exec(table('sessions') + ageIndex);
          else if (current === 1) {
            // Derived data: a cache from before automatic limits is discarded, not rewritten, and refills as searches match.
            // The VACUUM below rewrites the file without the dropped table, so zeroing its pages first only costs time.
            database.exec('PRAGMA secure_delete=OFF;');
            try { database.exec('DROP TABLE sessions;' + table('sessions') + ageIndex); } finally { database.exec('PRAGMA secure_delete=ON;'); }
          }
          else if (current !== 2) throw new Error('Unsupported search cache schema; use a new directory or purge with the compatible version');
          database.exec('PRAGMA user_version=2;');
        }, false);
      }
      // A lowered cap applies at once rather than at the next write.
      else if (index.total() > maxBytes) index.transaction(() => {}, false);
      // Enables incremental vacuuming on a new file, and shrinks a discarded cache from before automatic limits.
      if (database.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum !== 2) {
        try { database.exec('PRAGMA auto_vacuum=INCREMENTAL; VACUUM;'); } catch { /* Retried at the next open. */ }
      }
      if (load) index.reload();
      return index;
    } catch (error) { database.close(); throw error; }
  }

  private assertOpen(): void { if (this.closed) throw new Error('Search index is closed'); }
  private async assertCurrentCache(): Promise<void> {
    this.assertOpen();
    let info: Stats;
    let owner: string;
    try {
      [info, owner] = await Promise.all([lstat(join(this.directory, 'index.sqlite')), readFile(join(this.directory, 'owner'), 'utf8')]);
    } catch { throw new Error('Search cache was removed or replaced; close and reopen the index'); }
    checkPrivate(info, false);
    if (info.dev !== this.identity.dev || info.ino !== this.identity.ino || owner !== this.owner) {
      throw new Error('Search cache was removed or replaced; close and reopen the index');
    }
    this.assertOpen();
  }
  private version() { return this.database.prepare('PRAGMA data_version').get()?.data_version; }
  private reload(): void {
    // Capture before SELECT: a concurrent commit after SELECT must trigger another reload.
    const version = this.version();
    const sources = new Set(this.sources.map(sourceKey));
    try {
      this.rows = this.database.prepare('SELECT source, data FROM sessions').all()
        .filter((row) => sources.has(row.source as string))
        .map((row) => indexed(JSON.parse(row.data as string) as Session)).sort(sortSessions);
      this.dataVersion = version;
    } catch { throw new Error('Search cache is corrupt; use a fresh private directory and rebuild'); }
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.operations.then(async () => { await this.assertCurrentCache(); return operation(); });
    this.operations = next.catch(() => {});
    return next;
  }
  /** Writes, then evicts over the cap in the same transaction and returns freed pages to the file system. */
  private transaction(write: () => void, reload = true): void {
    this.database.exec('BEGIN IMMEDIATE');
    try { write(); this.evict(); this.database.exec('COMMIT'); } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    try { this.database.exec('PRAGMA incremental_vacuum;'); } catch { /* Freed pages are reused or reclaimed by a later write. */ }
    if (reload) this.reload();
    else this.dataVersion = undefined;
  }
  /** Over the cap, the least recently updated sessions (undated first) keep only their title, workspace and identity. */
  private total(): number { return Number(this.database.prepare('SELECT total(bytes) AS total FROM sessions').get()!.total); }
  private evict(): void {
    let total = this.total();
    if (total <= this.maxBytes) return;
    const clear = this.database.prepare(`UPDATE sessions SET bytes=0, data=json_set(data, '$.messages', json('[]')) WHERE source=? AND native_id=?`);
    for (const row of this.database.prepare('SELECT source, native_id, bytes FROM sessions WHERE bytes>0 ORDER BY updated, source, native_id').all()) {
      if (total <= this.maxBytes) break;
      clear.run(row.source as string, row.native_id as string);
      total -= Number(row.bytes);
    }
  }
  private insert(source: string, session: Session): void {
    const { updated, bytes, data } = stored(session);
    this.upsert ??= this.database.prepare('INSERT OR REPLACE INTO sessions(source, native_id, updated, bytes, data) VALUES (?, ?, ?, ?, ?)');
    this.upsert.run(source, session.nativeId, updated, bytes, data);
  }
  /** The persisted namespace of one configured provider. */
  private sourceKey(agent: AgentId): string {
    const source = this.sources.find((item) => item.adapter.id === agent);
    if (!source) throw new Error('Provider is not configured');
    return sourceKey(source);
  }

  /** Cache a complete matched transcript without loading any other cached records. */
  remember(session: Session): Promise<void> {
    const source = this.sourceKey(session.agent);
    return this.enqueue(async () => this.transaction(() => this.insert(source, session), false));
  }

  async remembered(session: Session, text: string): Promise<SessionHit | undefined> {
    await this.assertCurrentCache();
    const source = this.sources.find(item => item.adapter.id === session.agent);
    if (!source) return;
    const row = this.database.prepare('SELECT data FROM sessions WHERE source=? AND native_id=?').get(sourceKey(source), session.nativeId);
    if (!row) return;
    const cached = JSON.parse(row.data as string) as Session;
    return matchSession({...session, messages:cached.messages}, text);
  }

  /** Rehydrate and atomically replace selected provider generations, even at unchanged timestamps. */
  refresh(agent: AgentId | 'all' = 'all', options: { preserveMissing?: boolean } = {}): Promise<void> { return this.regenerate(agent, false, options.preserveMissing ?? false); }

  private regenerate(agent: AgentId | 'all', replaceAll: boolean, preserveMissing = false): Promise<void> {
    return this.enqueue(async () => {
      const selected = this.sources.filter((source) => agent === 'all' || source.adapter.id === agent);
      if (agent !== 'all' && selected.length === 0) throw new Error('Provider is not configured');
      const staged: { source: string; sessions: Session[] }[] = [];
      for (const source of selected) {
        const sessions: Session[] = [];
        const identities = new Set<string>();
        for (const discovered of await source.adapter.discover()) {
          if (discovered.agent !== source.adapter.id || identities.has(discovered.nativeId)) throw new Error('Adapter returned an invalid or duplicated provider session');
          identities.add(discovered.nativeId);
          // Copy only the public contract: adapter-specific metadata never enters the cache.
          const messages = (await source.adapter.readHistory(discovered.nativeId)).map(({ id, role, text, status }): HistoryItem => ({ id, role, text, status }));
          const session: Session = { id: discovered.id, nativeId: discovered.nativeId, agent: source.adapter.id,
            title: discovered.title, workspace: await canonical(discovered.workspace), updatedAt: discovered.updatedAt, messages };
          timestamp(session.updatedAt); // Validate before starting the transaction.
          sessions.push(session);
        }
        staged.push({ source: sourceKey(source), sessions });
      }
      await this.assertCurrentCache();
      this.transaction(() => {
        if (replaceAll) this.database.exec('DELETE FROM sessions');
        const remove = this.database.prepare('DELETE FROM sessions WHERE source=?');
        for (const generation of staged) {
          if (!preserveMissing) remove.run(generation.source);
          for (const session of generation.sessions) this.insert(generation.source, session);
        }
      });
    });
  }

  /** Replaces all configured providers from scratch, preserving the last generation on read failure. */
  rebuild(): Promise<void> { return this.regenerate('all', true); }

  /** Remove only derived text for one configured provider/session. Refresh can import it again. */
  deleteSession(agent: AgentId, nativeId: string): Promise<void> {
    return this.enqueue(async () => {
      const source = this.sourceKey(agent);
      this.transaction(() => { this.database.prepare('DELETE FROM sessions WHERE source=? AND native_id=?').run(source, nativeId); });
    });
  }

  /** Drop cached sessions of one provider that its complete, healthy discovery no longer lists. */
  prune(agent: AgentId, present: Iterable<string>): Promise<void> {
    return this.enqueue(async () => {
      const source = this.sourceKey(agent);
      this.transaction(() => {
        this.database.prepare('DELETE FROM sessions WHERE source=? AND native_id NOT IN (SELECT value FROM json_each(?))').run(source, JSON.stringify([...present]));
      }, false);
    });
  }

  async query(query: SessionQuery, signal?: AbortSignal): Promise<readonly SessionHit[]> {
    this.assertOpen(); signal?.throwIfAborted();
    await this.assertCurrentCache();
    const workspace = query.scope === 'folder' ? await canonical(query.workspace) : undefined;
    this.assertOpen(); signal?.throwIfAborted();
    if (this.version() !== this.dataVersion) this.reload();
    const needle = normalize(query.text.trim());
    const hits: SessionHit[] = [];
    for (const row of this.rows) {
      const { session } = row;
      if ((query.agent !== 'all' && session.agent !== query.agent) || (workspace !== undefined && workspace !== session.workspace)) continue;
      const hit = match(row, needle);
      if (hit) hits.push(hit);
    }
    signal?.throwIfAborted();
    return hits;
  }

  close(): Promise<void> {
    return this.operations.then(() => {
      if (!this.closed) { this.database.close(); this.closed = true; this.rows = []; }
    });
  }

  /** Close this service and remove its complete dedicated cache. Native histories are untouched. */
  purge(): Promise<void> {
    return this.enqueue(async () => {
      await validateDirectory(this.directory);
      this.database.close(); this.closed = true; this.rows = [];
      for (const file of files) {
        try { await unlink(join(this.directory, file)); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await rmdir(this.directory);
    });
  }
}
