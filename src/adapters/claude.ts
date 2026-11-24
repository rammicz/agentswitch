import { opendir, realpath, stat } from 'node:fs/promises';
import { nativeIncarnation } from '../continuity.js';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { HistoryItem, Session } from '../domain.js';
import type { SessionAdapter } from './index.js';
import { contains, defaultLimits, ReadContext } from './codex-io.js';
import type { CodexDiagnostic, CodexLimits } from './codex-io.js';
import { metadataRecords, object, records, text } from './claude-io.js';
import type { Entry, NativeRecord } from './claude-io.js';
import { conversation, graphEntry, metadataTypes, project, visible } from './claude-projection.js';
export type ClaudeDiagnostic = CodexDiagnostic;
/** `maxLineBytes` bounds discovery lines; `maxHistoryLineBytes` bounds lines in a selected history read. */
export type ClaudeLimits = Pick<CodexLimits, 'maxFiles' | 'maxFileBytes' | 'maxLineBytes' | 'maxDiagnostics' | 'maxScanBytes'> & { maxHistoryLineBytes: number };
export interface ClaudeAdapterOptions {
  /** Claude config directory, containing projects/, rather than projects/ itself. */
  root?: string; home?: string; env?: NodeJS.ProcessEnv;
  limits?: Partial<ClaudeLimits>; onDiagnostic?: (diagnostic: ClaudeDiagnostic) => void;
}
export interface ClaudeSession extends Session { createdAt: string; producerVersion?: string }
export interface ClaudeHistory { items: readonly HistoryItem[]; complete: boolean; diagnostics: readonly ClaudeDiagnostic[]; incarnation?:string; retained?:boolean }
interface File { path: string; id: string; mtime: number }
interface Metadata { cwd: string; created: string; prompt: string; customTitle: string; aiTitle: string; lastPrompt: string; summary: string; producer: string; sidechain: boolean; valid: boolean }
// History lines hold whole image tool results; see the limits section of docs/claude-reader.md.
const claudeDefaults = { ...defaultLimits, maxHistoryLineBytes: defaultLimits.maxFileBytes };
const filePattern = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
function date(value: unknown): string {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}
function firstPrompt(value: NativeRecord): string {
  if (value.type !== 'user' || !visible(value) || value.isCompactSummary) return '';
  const content = object(value.message).content;
  const candidate = typeof content === 'string' ? content : Array.isArray(content)
    ? content.map(object).filter(block => block.type === 'text').map(block => text(block.text)).join('\n') : '';
  if (/^(?:\[Request interrupted by user|<local-command|<command-name>|<task-notification>)/.test(candidate)) return '';
  return candidate.trim().slice(0, 200);
}

/** Read-only source-derived Claude Code 2.1.330 transcript reader. No CLI/provider invocation. */
export class ClaudeSessionAdapter implements SessionAdapter {
  readonly id = 'claude' as const;
  private readonly limits: typeof claudeDefaults;
  private root = '';
  private selected = new Map<string, File>();
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly options: ClaudeAdapterOptions = {}) {
    this.limits = { ...claudeDefaults, ...options.limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > claudeDefaults[key as keyof typeof claudeDefaults]) throw new RangeError(`Invalid Claude limit: ${key}`);
    }
  }
  /** One notification cap per public operation, shared by its discovery and history phases. */
  private notifier(): (diagnostic: ClaudeDiagnostic) => void {
    let notified = 0;
    return diagnostic => {
      if (notified >= this.limits.maxDiagnostics) return;
      notified++;
      this.options.onDiagnostic?.(notified === this.limits.maxDiagnostics
        ? { code: 'diagnostic-limit', source: diagnostic.source } : diagnostic);
    };
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.then(operation); this.pending = task.then(() => {}, () => {}); return task;
  }
  discover(signal?: AbortSignal): Promise<readonly ClaudeSession[]> { return this.run(() => this.catalog(new ReadContext(this.limits, this.notifier()), signal)); }
  private async files(ctx: ReadContext): Promise<File[]> {
    let count = 0;
    const list = async (path: string): Promise<import('node:fs').Dirent[]> => {
      try {
        if (!contains(this.root, await realpath(path))) { ctx.add('unsafe-path'); return []; }
        const entries = [], dir = await opendir(path);
        for await (const entry of dir) {
          if (++count > this.limits.maxFiles) { ctx.add('input-limit'); break; }
          entries.push(entry);
        }
        return entries.sort((a, b) => a.name.localeCompare(b.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.add('read-failed');
        return [];
      }
    };
    const files: File[] = [];
    const projects = join(this.root, 'projects');
    for (const bucket of await list(projects)) {
      if (count > this.limits.maxFiles) break;
      if (bucket.isSymbolicLink()) { ctx.add('unsafe-path'); continue; }
      if (!bucket.isDirectory()) continue;
      for (const entry of await list(join(projects, bucket.name))) {
        if (entry.isSymbolicLink()) { ctx.add('unsafe-path'); continue; }
        const match = filePattern.exec(entry.name);
        if (entry.isFile() && match) files.push({ path: join(projects, bucket.name, entry.name), id: match[1]!.toLowerCase(), mtime: 0 });
      }
    }
    return files;
  }
  private async metadata(file: File, ctx: ReadContext): Promise<Metadata | undefined> {
    const meta: Metadata = { cwd: '', created: '', prompt: '', customTitle: '', aiTitle: '', lastPrompt: '', summary: '', producer: '', sidechain: false, valid: false };
    const mtime = await metadataRecords(file.path, this.root, ctx, (value, line) => {
      const entry = graphEntry(value, line, file.id, ctx);
      if (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || value.sessionId.toLowerCase() !== file.id)) return;
      if (!entry && !metadataTypes.has(text(value.type))) return;
      if (entry) {
        if (!meta.cwd && typeof value.cwd === 'string' && isAbsolute(value.cwd)) meta.cwd = value.cwd;
        if (!meta.created) meta.created = date(value.timestamp);
        if (entry.type === 'user' || entry.type === 'assistant') {
          if (!meta.valid) meta.sidechain = Boolean(entry.isSidechain || entry.teamName);
          meta.valid = true;
          if (!meta.prompt) meta.prompt = firstPrompt(entry);
        }
      }
      for (const field of ['customTitle', 'aiTitle', 'lastPrompt', 'summary'] as const) {
        if (typeof value[field] === 'string') meta[field] = value[field].trim().slice(0, 500);
      }
      if (typeof value.version === 'string') {
        if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.version)) { ctx.add('unsupported-shape', 'metadata', line); return; }
        meta.producer = value.version;
        if (value.version !== '2.1.330') ctx.add('untested-producer', 'history', line, false);
      }
    }, () => meta.valid && meta.cwd !== '' && meta.prompt !== '');
    if (mtime === undefined) return;
    file.mtime = mtime;
    return meta;
  }
  private async catalog(ctx: ReadContext, signal?: AbortSignal): Promise<ClaudeSession[]> {
    signal?.throwIfAborted();
    this.selected = new Map();
    const env = this.options.env ?? process.env;
    const chosen = this.options.root ?? (env.CLAUDE_CONFIG_DIR?.trim() || join(this.options.home ?? homedir(), '.claude'));
    try { this.root = await realpath(resolve(chosen)); }
    catch { ctx.add('root-unavailable', 'root'); return []; }
    const sessions = new Map<string, ClaudeSession>();
    for (const file of await this.files(ctx)) {
      signal?.throwIfAborted();
      const meta = await this.metadata(file, ctx);
      if (!meta || !meta.valid || meta.sidechain) continue;
      if (!meta.cwd) { ctx.add('metadata-unavailable', 'metadata'); continue; }
      let workspace = resolve(meta.cwd).normalize('NFC');
      try { workspace = (await realpath(meta.cwd)).normalize('NFC'); }
      catch { ctx.add('workspace-unavailable', 'workspace', undefined, false); }
      const prior = this.selected.get(file.id);
      if (prior) {
        ctx.add('unsupported-shape', 'metadata', undefined, false);
        if (prior.mtime >= file.mtime) continue;
      }
      this.selected.set(file.id, file);
      sessions.set(file.id, { id: `claude:${file.id}`, agent: 'claude', nativeId: file.id,
        workspace, title: meta.customTitle || meta.aiTitle || meta.lastPrompt || meta.summary || meta.prompt || `Claude ${file.id}`,
        createdAt: meta.created || new Date(file.mtime).toISOString(), updatedAt: new Date(file.mtime).toISOString(), messages: [],
        ...(meta.producer ? { producerVersion: meta.producer } : {}) });
    }
    return [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  async readHistory(nativeId: string): Promise<readonly HistoryItem[]> { return (await this.readHistoryDetailed(nativeId)).items; }
  readHistoryDetailed(nativeId: string): Promise<ClaudeHistory> { return this.readDetailed(nativeId, true); }
  /** Read the preceding catalog generation without rescanning sibling sessions. For refresh composition only. */
  readCatalogHistoryDetailed(nativeId: string): Promise<ClaudeHistory> { return this.readDetailed(nativeId, false); }
  readCatalogExcerpt(nativeId: string, signal: AbortSignal): Promise<ClaudeHistory> {
    return this.readDetailed(nativeId, false, signal);
  }
  private readDetailed(nativeId: string, rediscover: boolean, excerptSignal?: AbortSignal): Promise<ClaudeHistory> {
    return this.run(async () => {
      excerptSignal?.throwIfAborted();
      const notify = excerptSignal ? undefined : this.notifier();
      if (rediscover) await this.catalog(new ReadContext(this.limits, notify));
      // The selected history gets its own byte budget, so the size of sibling sessions never truncates it.
      const ctx = new ReadContext({ ...this.limits, maxLineBytes: this.limits.maxHistoryLineBytes }, notify);
      const file = this.selected.get(nativeId.toLowerCase());
      if (!file) { ctx.add('selected-rollout-unavailable'); return { items: [], complete: false, diagnostics: ctx.diagnostics }; }
      const entries: Entry[] = [];
      await records(file.path, this.root, ctx, (value, line) => {
        const entry = graphEntry(value, line, file.id, ctx); if (entry) entries.push(entry);
      }, excerptSignal ? Math.min(512 * 1024, ctx.limits.maxFileBytes) : undefined);
      const items = project(conversation(entries, ctx), file.id, ctx);
      return { items, complete: ctx.complete, diagnostics: ctx.diagnostics, incarnation:nativeIncarnation(await stat(file.path)),retained:false };
    });
  }
}
