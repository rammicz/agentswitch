import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
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
}
interface IndexedSession {
  session: Session;
  title: string;
  workspace: string;
  texts: string[];
  time: number;
}
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
  const { id, agent, nativeId, title, updatedAt, lastUsedAt } = session;
  return { id, agent, nativeId, title, workspace: session.workspace, updatedAt, ...(lastUsedAt ? {lastUsedAt} : {}), matches };
}

export function matchSession(session: Session, query: string): SessionHit | undefined {
  return match(indexed(session), normalize(query.trim()));
}

/** Offline public-text index. Refresh is explicit; queries never call an adapter. */
export class SearchIndex {
  private rows: IndexedSession[] = [];
  private closed = false;
  private dataVersion: SQLOutputValue | undefined;
  private operations: Promise<void> = Promise.resolve();
  private constructor(private readonly directory: string, private readonly sources: readonly SearchSource[], private readonly database: DatabaseSync, private readonly owner: string, private readonly identity: Stats) {}

  static async open(options: SearchIndexOptions, { load = true } = {}): Promise<SearchIndex> {
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
      const version = database.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error('Unsupported search cache schema; use a new directory or purge with the compatible version');
      database.exec('CREATE TABLE IF NOT EXISTS sessions (source TEXT NOT NULL, native_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(source, native_id)); PRAGMA user_version=1;');
      const index = new SearchIndex(directory, options.sources.map((source) => ({ ...source })), database, owner, await lstat(filename));
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
  private transaction(write: () => void, reload = true): void {
    this.database.exec('BEGIN IMMEDIATE');
    try { write(); this.database.exec('COMMIT'); } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    if (reload) this.reload();
    else this.dataVersion = undefined;
  }

  /** Cache a complete matched transcript without loading any other cached records. */
  remember(session: Session): Promise<void> {
    const source = this.sources.find(item => item.adapter.id === session.agent);
    if (!source) throw new Error('Provider is not configured');
    const {id, nativeId, agent, title, workspace, updatedAt, messages} = session;
    const data = JSON.stringify({id, nativeId, agent, title, workspace, updatedAt,
      messages: messages.map(({id, role, status, text}) => ({id, role, status, text}))});
    return this.enqueue(async () => this.transaction(() => {
      this.database.prepare('INSERT OR REPLACE INTO sessions(source, native_id, data) VALUES (?, ?, ?)').run(sourceKey(source), nativeId, data);
    }, false));
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
        const insert = this.database.prepare('INSERT OR REPLACE INTO sessions(source, native_id, data) VALUES (?, ?, ?)');
        for (const generation of staged) {
          if (!preserveMissing) remove.run(generation.source);
          for (const session of generation.sessions) insert.run(generation.source, session.nativeId, JSON.stringify(session));
        }
      });
    });
  }

  /** Replaces all configured providers from scratch, preserving the last generation on read failure. */
  rebuild(): Promise<void> { return this.regenerate('all', true); }

  /** Remove only derived text for one configured provider/session. Refresh can import it again. */
  deleteSession(agent: AgentId, nativeId: string): Promise<void> {
    return this.enqueue(async () => {
      const source = this.sources.find((item) => item.adapter.id === agent);
      if (!source) throw new Error('Provider is not configured');
      this.transaction(() => { this.database.prepare('DELETE FROM sessions WHERE source=? AND native_id=?').run(sourceKey(source), nativeId); });
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
