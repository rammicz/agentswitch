import { opendir, realpath, stat } from 'node:fs/promises';
import { nativeIncarnation, type NativeItemTurn } from '../continuity.js';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, isAbsolute } from 'node:path';
import type { HistoryItem, Session } from '../domain.js';
import type { SessionAdapter } from './index.js';
import { boundedRead, contains, defaultLimits, historyBytes, historyHeader, historyTitlePrefix, metadataSnapshot, ReadContext } from './codex-io.js';
import type { CodexDiagnostic, CodexLimits, MetadataRow } from './codex-io.js';
import { object, project, text } from './codex-projection.js';
import type { ObjectRecord, SourceRecord } from './codex-projection.js';
export type { CodexDiagnostic, CodexLimits } from './codex-io.js';
export interface CodexAdapterOptions {
  root?: string; sqliteRoot?: string; home?: string; env?: NodeJS.ProcessEnv;
  limits?: Partial<CodexLimits>; onDiagnostic?: (diagnostic: CodexDiagnostic) => void;
}
export interface CodexSession extends Session {
  createdAt: string; historyMode: 'legacy' | 'paginated'; producerVersion: string;
  metadataFidelity: 'native' | 'reduced';
}
export interface CodexHistory { items: readonly HistoryItem[]; complete: boolean; diagnostics: readonly CodexDiagnostic[]; incarnation?:string; retained?:boolean; itemTurns?:readonly NativeItemTurn[] }
interface RolloutFile { path: string; owner: string; rolloutId: string }
interface ParsedRollout { file: RolloutFile; meta: ObjectRecord; records: SourceRecord[] }
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const filePattern = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${uuid})(?:_(${uuid}))?\\.jsonl(?:\\.zst)?$`);
function identify(path: string): RolloutFile | undefined {
  const match = filePattern.exec(basename(path));
  return match?.[1] ? { path, owner: match[1], rolloutId: match[2] ?? match[1] } : undefined;
}
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function date(value: unknown): string | undefined {
  const ms = typeof value === 'number' ? (value < 100_000_000_000 ? value * 1000 : value) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined;
}
function displayTitle(mode: string, row: MetadataRow | undefined, indexedName?: string): string {
  const title = text(row?.title).trim(), preview = text(row?.preview).trim();
  if (mode === 'paginated') return text(row?.name).trim() || preview || title;
  const distinct = title && title !== text(row?.first_user_message).trim() ? title : '';
  let guardian = false;
  try { guardian = title === 'Guardian review' && object(object(JSON.parse(text(row?.source))).subagent).other === 'guardian'; }
  catch { /* A missing or unrecognized source cannot establish a Guardian default. */ }
  return (guardian ? indexedName || distinct : distinct || indexedName) || preview || title;
}
function subagentTitle(meta: ObjectRecord): string {
  const spawn = object(object(object(meta.source).subagent).thread_spawn);
  const field = (value: unknown) => /^[\p{L}\p{N} _-]{1,48}$/u.test(text(value)) ? text(value).trim() : '';
  const nickname = field(spawn.agent_nickname);
  const role = field(spawn.agent_role);
  if (nickname) return `${nickname} (${role || 'subagent'})`;
  return role ? `${role} subagent` : '';
}
function parseRecords(bytes: Buffer, source: string, ctx: ReadContext): SourceRecord[] {
  const records: SourceRecord[] = [];
  let offset = 0, line = 0;
  while (offset < bytes.length) {
    line++;
    const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline + 1;
    const chunk = bytes.subarray(offset, newline < 0 ? end : end - 1);
    if (chunk.length > ctx.limits.maxLineBytes) ctx.add('input-limit', 'history', line);
    else {
      try {
        const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(chunk)));
        if (!value.type || !value.payload) throw new Error();
        records.push({ value, offset, end, line, source, ...(integer(value.ordinal) ? { ordinal: value.ordinal } : {}) });
      } catch { ctx.add(newline < 0 ? 'partial-record' : 'malformed-record', 'history', line); }
    }
    offset = end;
  }
  return records;
}
async function parseFile(file: RolloutFile, root: string, ctx: ReadContext, cutoff?: number, headerOnly = false): Promise<ParsedRollout | undefined> {
  const input = await (headerOnly ? historyHeader(file.path, root, ctx) : historyBytes(file.path, root, ctx));
  if (!input) return;
  if (cutoff !== undefined && (cutoff > input.length || cutoff < 1 || input[cutoff - 1] !== 10)) { ctx.add('invalid-boundary'); return; }
  const bytes = cutoff === undefined ? input : input.subarray(0, cutoff);
  return parseRollout(file, bytes, ctx);
}
function parseRollout(file: RolloutFile, bytes: Buffer, ctx: ReadContext): ParsedRollout | undefined {
  const records = parseRecords(bytes, file.rolloutId, ctx), first = records[0];
  if (!first || first.offset !== 0 || first.value.type !== 'session_meta') { ctx.add('unsupported-shape'); return; }
  const meta = object(first.value.payload);
  if (meta.id !== file.owner) { ctx.add('invalid-owner'); return; }
  const mode = meta.history_mode === undefined ? 'legacy' : meta.history_mode;
  if (mode !== 'legacy' && mode !== 'paginated') { ctx.add('unsupported-mode'); return; }
  if (!isAbsolute(text(meta.cwd)) || !date(meta.timestamp) ||
      (meta.subagent_history_start_ordinal != null && !integer(meta.subagent_history_start_ordinal)) ||
      (meta.forked_from_ordinal_exclusive != null && !integer(meta.forked_from_ordinal_exclusive)) ||
      (meta.attached_thread != null && typeof meta.attached_thread !== 'boolean')) { ctx.add('unsupported-shape'); return; }
  if (mode === 'paginated') {
    const base = meta.history_base == null ? 0 : object(meta.history_base).end_ordinal_exclusive;
    if (!integer(base)) { ctx.add('invalid-boundary'); return; }
    const accepted: SourceRecord[] = [];
    for (const record of records) {
      // Physical record positions remain fixed across malformed interior records.
      if (record.ordinal !== base + record.line - 1) { ctx.add('invalid-ordinal', 'history', record.line); continue; }
      accepted.push(record);
    }
    if (accepted[0] !== first) return;
    return { file, meta, records: accepted };
  }
  return { file, meta, records };
}

/** Codex 0.171 source-format reader. No native CLI, account configuration or provider is invoked. */
export class CodexSessionAdapter implements SessionAdapter {
  readonly id = 'codex' as const;
  private readonly options: CodexAdapterOptions;
  private readonly limits: CodexLimits;
  private root = '';
  private readonly selected = new Map<string, RolloutFile>();
  private files: RolloutFile[] = [];
  private pending: Promise<void> = Promise.resolve();
  constructor(options: CodexAdapterOptions = {}) {
    this.options = options;
    this.limits = { ...defaultLimits, ...options.limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > defaultLimits[key as keyof CodexLimits]) throw new RangeError(`Invalid Codex limit: ${key}`);
    }
  }
  private context(): ReadContext { return new ReadContext(this.limits, this.options.onDiagnostic); }
  private async scan(ctx: ReadContext): Promise<RolloutFile[]> {
    const found: RolloutFile[] = [];
    let entries = 0;
    const walk = async (path: string, depth: number): Promise<void> => {
      if (depth > 5 || entries >= this.limits.maxFiles) { ctx.add('input-limit'); return; }
      let list;
      try {
        const canonical = await realpath(path);
        if (!contains(this.root, canonical)) { ctx.add('unsafe-path'); return; }
        list = [];
        const directory = await opendir(canonical);
        for await (const entry of directory) {
          list.push(entry);
          if (list.length >= this.limits.maxFiles - entries) { ctx.add('input-limit'); break; }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.add('read-failed');
        return;
      }
      list.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of list) {
        if (++entries > this.limits.maxFiles) { ctx.add('input-limit'); return; }
        const child = join(path, entry.name);
        if (entry.isSymbolicLink()) { ctx.add('unsafe-path'); continue; }
        if (entry.isDirectory()) await walk(child, depth + 1);
        else if (entry.isFile()) { const file = identify(child); if (file) found.push(file); }
      }
    };
    await walk(join(this.root, 'sessions'), 0);
    await walk(join(this.root, 'archived_sessions'), 0);
    // Plain is preferred if an atomic compression transition leaves both copies.
    const unique = new Map<string, RolloutFile>();
    for (const file of found) {
      const prior = unique.get(file.rolloutId);
      if (!prior || (prior.path.endsWith('.zst') && !file.path.endsWith('.zst'))) unique.set(file.rolloutId, file);
    }
    return [...unique.values()];
  }
  private async legacyNames(ctx: ReadContext): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    try {
      const bytes = await boundedRead(join(this.root, 'session_index.jsonl'), this.root, this.limits.maxMetadataBytes, ctx);
      let count = 0;
      for (const raw of bytes.toString('utf8').split('\n')) {
        if (!raw) continue;
        if (++count > this.limits.maxFiles || Buffer.byteLength(raw) > this.limits.maxLineBytes) { ctx.add('input-limit', 'metadata'); break; }
        try { const row = object(JSON.parse(raw)); if (text(row.id) && text(row.thread_name)) names.set(text(row.id), text(row.thread_name)); }
        catch { ctx.add('malformed-record', 'metadata'); }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.add(error instanceof Error && error.message === 'input-limit' ? 'input-limit' : 'metadata-unavailable', 'metadata', undefined, false); }
    return names;
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => {}, () => {});
    return result;
  }
  discover(signal?: AbortSignal): Promise<readonly CodexSession[]> { return this.run(() => this.discoverCatalog(this.context(), signal)); }
  private async discoverCatalog(ctx = this.context(), signal?: AbortSignal): Promise<readonly CodexSession[]> {
    signal?.throwIfAborted();
    const env = this.options.env ?? process.env;
    try { this.root = await realpath(resolve(this.options.root ?? (env.CODEX_HOME?.trim() || join(this.options.home ?? homedir(), '.codex')))); }
    catch { ctx.add('root-unavailable', 'root'); this.selected.clear(); return []; }
    this.files = await this.scan(ctx);
    let sqliteRoot = this.root;
    try { sqliteRoot = await realpath(resolve(this.options.sqliteRoot ?? (env.CODEX_SQLITE_HOME?.trim() || this.root))); }
    catch { ctx.add('metadata-unavailable', 'metadata', undefined, false); sqliteRoot = ''; }
    const rows = sqliteRoot ? await metadataSnapshot(sqliteRoot, ctx) : [];
    const metadata = new Map(rows.filter(row => text(row.id)).map(row => [text(row.id), row]));
    const names = await this.legacyNames(ctx);
    const candidates = new Map<string, ParsedRollout[]>();
    for (const file of this.files) {
      signal?.throwIfAborted();
      if (ctx.bytes > ctx.limits.maxScanBytes) break;
      const parsed = await parseFile(file, this.root, ctx, undefined, true);
      if (parsed) candidates.set(file.owner, [...(candidates.get(file.owner) ?? []), parsed]);
    }
    const sessions: CodexSession[] = [];
    this.selected.clear();
    for (const [id, variants] of candidates) {
      signal?.throwIfAborted();
      const row = metadata.get(id);
      let chosen: ParsedRollout | undefined;
      if (row && typeof row.rollout_path === 'string') {
        try {
          const path = resolve(this.root, row.rollout_path);
          // Resolve directory aliases while retaining the filename across compression transitions.
          // A selected file symlink must not substitute for a scanned managed file.
          const selectedPath = join(await realpath(dirname(path)), basename(path));
          if (contains(this.root, selectedPath)) chosen = variants.find(variant => variant.file.path.replace(/\.zst$/, '') === selectedPath.replace(/\.zst$/, ''));
        } catch { /* An unavailable selected directory cannot identify a managed rollout. */ }
        if (!chosen) { ctx.add('selected-rollout-unavailable', 'metadata'); continue; }
      } else if (variants.length === 1) chosen = variants[0];
      else { ctx.add('ambiguous-rollout', 'metadata'); continue; }
      if (!chosen) continue;
      const meta = chosen.meta, mode = meta.history_mode === 'paginated' ? 'paginated' : 'legacy';
      const producer = text(meta.cli_version);
      if (producer !== '0.171.0') ctx.add('untested-producer', 'history', undefined, false);
      const rawWorkspace = text(meta.cwd);
      let workspace = resolve(rawWorkspace);
      try { workspace = await realpath(rawWorkspace); }
      catch { ctx.add('workspace-unavailable', 'workspace', undefined, false); }
      const nativeName = displayTitle(mode, row, names.get(id));
      if (!row && mode === 'paginated') ctx.add('metadata-unavailable', 'metadata', undefined, false);
      this.selected.set(id, chosen.file);
      sessions.push({ id: `codex:${id}`, agent: 'codex', nativeId: id, title: nativeName || subagentTitle(meta) || `Codex ${id}`,
        workspace, createdAt: date(row?.created_at) ?? date(meta.timestamp)!, updatedAt: date(row?.updated_at) ?? date(meta.timestamp)!,
        messages: [], historyMode: mode, producerVersion: producer, metadataFidelity: row ? 'native' : 'reduced' });
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  async readHistory(nativeId: string): Promise<readonly HistoryItem[]> { return (await this.readHistoryDetailed(nativeId)).items; }
  readHistoryDetailed(nativeId: string): Promise<CodexHistory> { return this.run(() => this.readDetailed(nativeId)); }

  /** Read the preceding catalog generation without rescanning sibling sessions. For refresh composition only. */
  readCatalogHistoryDetailed(nativeId: string): Promise<CodexHistory> { return this.run(() => this.readDetailed(nativeId, false)); }
  readCatalogTitleItems(nativeId: string, signal: AbortSignal): Promise<readonly HistoryItem[]> {
    return this.run(async () => {
      signal.throwIfAborted();
      const file = this.selected.get(nativeId);
      if (!file) return [];
      const ctx = new ReadContext(this.limits);
      const bytes = await historyTitlePrefix(file.path, this.root, ctx);
      const leaf = parseRollout(file, bytes, ctx);
      if (!leaf || !ctx.complete) return [];
      const { meta, records } = leaf;
      const base = object(meta.history_base).end_ordinal_exclusive;
      const start = integer(meta.subagent_history_start_ordinal) ? meta.subagent_history_start_ordinal
        : meta.attached_thread === true && integer(base) ? base + 1 : 0;
      return project(records.slice(1).filter(record => (record.ordinal ?? 0) >= start),
        meta.history_mode === 'paginated' ? 'paginated' : 'legacy', ctx);
    });
  }
  private async readDetailed(nativeId: string, rediscover = true): Promise<CodexHistory> {
    // Public selected-session reads refresh authoritative selection; catalog batches use their explicit generation.
    const discovery = this.context();
    if (rediscover) await this.discoverCatalog(discovery);
    const ctx = discovery.fork(), file = this.selected.get(nativeId);
    if (!file) { ctx.add('selected-rollout-unavailable'); return { items: [], complete: false, diagnostics: ctx.diagnostics }; }
    const leaf = await parseFile(file, this.root, ctx);
    const records = leaf ? await this.lineage(leaf, ctx, new Set(), 0) : [];
    const turns=new Map<string,NativeItemTurn>();
    const items = project(records, leaf?.meta.history_mode === 'paginated' ? 'paginated' : 'legacy', ctx,turns);
    const incarnation=nativeIncarnation(await stat(file.path));
    const retained=leaf?.meta.history_mode==='paginated'&&!records.some(record=>/compact/i.test(String(record.value.type))||/compact/i.test(String(object(record.value.payload).type))||/compact/i.test(String(object(object(record.value.payload).item).type)));
    return { items, complete: ctx.complete, diagnostics: ctx.diagnostics, incarnation, retained, itemTurns:[...turns.values()] };
  }
  private async lineage(parsed: ParsedRollout, ctx: ReadContext, seen: Set<string>, depth: number): Promise<SourceRecord[]> {
    if (seen.has(parsed.file.rolloutId)) { ctx.add('ancestry-cycle'); return []; }
    if (depth >= this.limits.maxDepth) { ctx.add('input-limit'); return []; }
    seen.add(parsed.file.rolloutId);
    const meta = parsed.meta;
    const displayStart = meta.subagent_history_start_ordinal;
    const own = parsed.records.slice(1).filter(record => !integer(displayStart) || (record.ordinal ?? 0) >= displayStart);
    const base = meta.history_base;
    if (base == null) return own;
    const boundary = object(base);
    const end = boundary.end_ordinal_exclusive, bytes = boundary.end_byte_offset;
    if (!integer(end) || !integer(bytes) || !text(boundary.thread_id)) { ctx.add('invalid-boundary'); return own; }
    // Attached children hide inherited model context from their public transcript.
    if (meta.attached_thread === true && integer(meta.forked_from_ordinal_exclusive) && end <= meta.forked_from_ordinal_exclusive) {
      const start = integer(meta.subagent_history_start_ordinal) ? meta.subagent_history_start_ordinal : end + 1;
      return own.filter(record => (record.ordinal ?? 0) >= start);
    }
    if (seen.has(text(boundary.thread_id))) { ctx.add('ancestry-cycle'); return own; }
    const parentFile = this.files.find(candidate => candidate.rolloutId === boundary.thread_id);
    if (!parentFile) { ctx.add('ancestry-unavailable'); return own; }
    const parent = await parseFile(parentFile, this.root, ctx, bytes);
    if (!parent || parent.meta.history_mode !== 'paginated') { ctx.add('ancestry-unavailable'); return own; }
    const last = parent.records.at(-1);
    if (!last || last.end !== bytes || last.ordinal !== end - 1 || !parent.records.every(record => (record.ordinal ?? end) < end)) { ctx.add('invalid-boundary'); return own; }
    const inherited = await this.lineage(parent, ctx, seen, depth + 1);
    const start = meta.subagent_history_start_ordinal;
    return [...inherited, ...own].filter(record => !integer(start) || (record.ordinal ?? 0) >= start);
  }
}
