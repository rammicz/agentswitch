import { constants } from 'node:fs';
import { open, realpath, stat, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createZstdDecompress } from 'node:zlib';
import { Readable } from 'node:stream';

export type DiagnosticCode = 'root-unavailable' | 'unsafe-path' | 'read-failed' | 'input-limit' |
  'malformed-record' | 'partial-record' | 'unsupported-mode' | 'unsupported-shape' |
  'untested-producer' | 'workspace-unavailable' | 'metadata-unavailable' |
  'metadata-schema' | 'metadata-unstable' | 'selected-rollout-unavailable' |
  'ambiguous-rollout' | 'ancestry-unavailable' | 'ancestry-cycle' | 'invalid-boundary' |
  'invalid-owner' | 'invalid-ordinal' | 'compressed-invalid' | 'diagnostic-limit';
export interface CodexDiagnostic { code: DiagnosticCode; source: 'history' | 'metadata' | 'workspace' | 'root'; line?: number }
/** `maxLineBytes` bounds discovery, header and metadata lines; `maxHistoryLineBytes` bounds lines in a history read. */
export interface CodexLimits {
  maxFiles: number; maxFileBytes: number; maxDecodedBytes: number; maxLineBytes: number; maxHistoryLineBytes: number;
  maxDepth: number; maxDiagnostics: number; maxMetadataBytes: number; maxScanBytes: number;
}
export const defaultLimits: CodexLimits = {
  maxFiles: 10_000, maxFileBytes: 32 * 1024 * 1024, maxDecodedBytes: 64 * 1024 * 1024,
  // Image tool results are single lines over 1 MiB; a history line never extends past the file cap anyway.
  maxLineBytes: 1024 * 1024, maxHistoryLineBytes: 32 * 1024 * 1024, maxDepth: 32, maxDiagnostics: 100,
  maxMetadataBytes: 64 * 1024 * 1024, maxScanBytes: 256 * 1024 * 1024,
};
/** The limits of a history read: its lines may be as long as `maxHistoryLineBytes`. */
export function historyLimits(limits: CodexLimits): CodexLimits { return { ...limits, maxLineBytes: limits.maxHistoryLineBytes }; }
/** The complete lines of a prefix. */
function completeLines(bytes: Buffer): Buffer { return bytes.subarray(0, bytes.lastIndexOf(10) + 1); }
export class ReadContext {
  readonly diagnostics: CodexDiagnostic[] = [];
  complete = true;
  private decodedBytes = 0;
  constructor(readonly limits: CodexLimits, private readonly notify?: (diagnostic: CodexDiagnostic) => void,
    private readonly budget: { bytes: number } = { bytes: 0 }) {}
  get bytes(): number { return this.budget.bytes; }
  set bytes(value: number) { this.budget.bytes = value; }
  get remaining(): number { return this.limits.maxScanBytes - this.bytes; }
  get remainingDecoded(): number { return this.limits.maxDecodedBytes - this.decodedBytes; }
  consumeDecoded(bytes: number): void {
    if (bytes > this.remainingDecoded) throw new Error('input-limit');
    this.decodedBytes += bytes;
  }
  /** A context spending the same byte budget, optionally under other limits. */
  fork(limits = this.limits): ReadContext { return new ReadContext(limits, this.notify, this.budget); }
  add(code: DiagnosticCode, source: CodexDiagnostic['source'] = 'history', line?: number, incomplete = true): void {
    if (incomplete) this.complete = false;
    if (this.diagnostics.length >= this.limits.maxDiagnostics) return;
    const diagnostic: CodexDiagnostic = this.diagnostics.length === this.limits.maxDiagnostics - 1
      ? { code: 'diagnostic-limit', source }
      : { code, source, ...(line === undefined ? {} : { line }) };
    this.diagnostics.push(diagnostic);
    this.notify?.(diagnostic);
  }
}
export function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}
/** Resolve symlinks before opening; final-component swaps fail through O_NOFOLLOW. */
export async function boundedRead(path: string, root: string, limit: number, ctx: ReadContext, prefixOnly = false): Promise<Buffer> {
  return (await boundedReadWithStat(path, root, limit, ctx, prefixOnly)).data;
}
async function boundedReadWithStat(path: string, root: string, limit: number, ctx: ReadContext, prefixOnly: boolean):
  Promise<{ data: Buffer; size: number; modified: number }> {
  const canonical = await realpath(path);
  if (!contains(root, canonical)) throw new Error('unsafe-path');
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    const allowed = Math.min(limit, ctx.remaining);
    if (!info.isFile() || (!prefixOnly && info.size > allowed)) throw new Error('input-limit');
    const data = Buffer.alloc(Math.min(info.size, allowed));
    let offset = 0;
    while (offset < data.length) {
      const requested = Math.min(data.length - offset, ctx.remaining);
      if (requested < 1) throw new Error('input-limit');
      const { bytesRead } = await handle.read(data, offset, requested, offset);
      ctx.bytes += bytesRead;
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { data: data.subarray(0, offset), size: info.size, modified: info.mtimeMs };
  } finally { await handle.close(); }
}

/** Complete records from a bounded prefix for a display label only. */
export async function historyTitlePrefix(path: string, root: string, ctx: ReadContext): Promise<Buffer> {
  const limit = Math.min(512 * 1024, ctx.limits.maxFileBytes, ctx.remainingDecoded);
  const compressed = path.endsWith('.zst');
  const input = await boundedRead(path, root, limit, ctx, !compressed);
  if (!compressed) return completeLines(input);
  const stream = Readable.from([input]).pipe(createZstdDecompress());
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const value of stream) {
      const chunk = (value as Buffer).subarray(0, limit - size);
      chunks.push(chunk);
      size += chunk.length;
      if (size === limit) break;
    }
    return completeLines(Buffer.concat(chunks, size));
  } finally { stream.destroy(); }
}
/** Discovery consumes only the first record, leaving transcript validation to lazy reads. */
export async function historyHeader(path: string, root: string, ctx: ReadContext): Promise<Buffer | undefined> {
  try {
    if (!path.endsWith('.zst')) {
      const canonical = await realpath(path);
      if (!contains(root, canonical)) throw new Error('unsafe-path');
      const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('read-failed');
        const chunks: Buffer[] = [];
        let size = 0;
        while (true) {
          const requested = Math.min(16 * 1024, ctx.limits.maxLineBytes + 1 - size, ctx.remaining);
          if (requested < 1) throw new Error('input-limit');
          const buffer = Buffer.alloc(requested);
          const { bytesRead } = await handle.read(buffer, 0, requested, size);
          ctx.bytes += bytesRead;
          const data = buffer.subarray(0, bytesRead), newline = data.indexOf(10);
          const prefix = newline < 0 ? data : data.subarray(0, newline + 1);
          chunks.push(prefix);
          size += prefix.length;
          if (size > ctx.limits.maxLineBytes) throw new Error('input-limit');
          if (newline >= 0 || bytesRead === 0 || size === info.size) return Buffer.concat(chunks, size);
        }
      } finally { await handle.close(); }
    }
    const input = await boundedRead(path, root, ctx.limits.maxFileBytes, ctx);
    const stream = Readable.from([input]).pipe(createZstdDecompress());
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const value of stream) {
        const chunk = Buffer.from(value as Uint8Array), newline = chunk.indexOf(10);
        const part = newline < 0 ? chunk : chunk.subarray(0, newline + 1);
        size += part.length;
        if (size > ctx.limits.maxLineBytes || size > ctx.limits.maxDecodedBytes) throw new Error('input-limit');
        chunks.push(part);
        if (newline >= 0) return Buffer.concat(chunks, size);
      }
      return Buffer.concat(chunks, size);
    } finally { stream.destroy(); }
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    ctx.add(code === 'unsafe-path' || code === 'input-limit' ? code : path.endsWith('.zst') ? 'compressed-invalid' : 'read-failed');
    return undefined;
  }
}
/**
 * Bytes of one rollout and its modification time. Only the first `wanted` bytes are read when given (a parent cutoff).
 * A plain leaf that does not fit keeps its complete lines with `input-limit`; a parent cutoff or a compressed file that
 * does not fit is all or nothing.
 */
export async function historyBytes(path: string, root: string, ctx: ReadContext, wanted = Infinity):
  Promise<{ bytes: Buffer; modified: number } | undefined> {
  try {
    if (ctx.remainingDecoded < 1) throw new Error('input-limit');
    if (!path.endsWith('.zst')) {
      const { data, size, modified } = await boundedReadWithStat(path, root, Math.min(ctx.limits.maxFileBytes, ctx.remainingDecoded, wanted), ctx, true);
      let bytes = data;
      if (data.length < Math.min(size, wanted)) {
        if (wanted !== Infinity) throw new Error('input-limit');
        ctx.add('input-limit');
        bytes = completeLines(data);
        if (!bytes.length) return undefined;
      }
      ctx.consumeDecoded(bytes.length);
      return { bytes, modified };
    }
    const { data: input, modified } = await boundedReadWithStat(path, root, ctx.limits.maxFileBytes, ctx, false);
    const stream = Readable.from([input]).pipe(createZstdDecompress());
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of stream) {
        const data = Buffer.from(chunk as Uint8Array);
        size += data.length;
        ctx.consumeDecoded(data.length);
        chunks.push(data);
      }
      return { bytes: Buffer.concat(chunks, size), modified };
    } finally { stream.destroy(); }
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    ctx.add(code === 'unsafe-path' || code === 'input-limit' ? code : path.endsWith('.zst') ? 'compressed-invalid' : 'read-failed');
    return undefined;
  }
}
export type MetadataRow = Record<string, unknown>;
const metadataFields = ['id', 'rollout_path', 'created_at', 'updated_at', 'cwd', 'title', 'name', 'preview', 'recency_at', 'first_user_message', 'source'];
async function signature(path: string): Promise<string> {
  try {
    const info = await stat(path, { bigint: true });
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}
/** Never open the native database with SQLite: recovery/sidecars belong only to this private copy. */
export async function metadataSnapshot(root: string, ctx: ReadContext): Promise<MetadataRow[]> {
  const path = join(root, 'state_5.sqlite');
  const files = [path, `${path}-wal`];
  for (let attempt = 0; attempt < 3; attempt++) {
    let temporary: string | undefined;
    try {
      const before = await Promise.all(files.map(signature));
      if (before[0] === 'absent') { ctx.add('metadata-unavailable', 'metadata', undefined, false); return []; }
      const copies: (Buffer | undefined)[] = [];
      for (let index = 0; index < files.length; index++) {
        copies.push(before[index] === 'absent' ? undefined : await boundedRead(files[index]!, root, ctx.limits.maxMetadataBytes, ctx));
      }
      const after = await Promise.all(files.map(signature));
      if (before.some((value, index) => value !== after[index])) continue;
      temporary = await mkdtemp(join(tmpdir(), 'agentswitch-codex-snapshot-'));
      for (let index = 0; index < copies.length; index++) {
        const bytes = copies[index];
        if (bytes) await writeFile(join(temporary, index === 0 ? 'state.sqlite' : 'state.sqlite-wal'), bytes, { mode: 0o600 });
      }
      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(join(temporary, 'state.sqlite'));
      try {
        const columns = database.prepare('PRAGMA table_info(threads)').all().map(row => row.name);
        if (!['id','rollout_path','created_at','updated_at','cwd','title'].every(name => columns.includes(name))) {
          ctx.add('metadata-schema', 'metadata', undefined, false); return [];
        }
        const fields = metadataFields.filter(name => columns.includes(name)).join(',');
        const rows = database.prepare(`SELECT ${fields} FROM threads LIMIT ?`).all(ctx.limits.maxFiles + 1);
        if (rows.length > ctx.limits.maxFiles) ctx.add('input-limit', 'metadata');
        return rows.slice(0, ctx.limits.maxFiles);
      } finally { database.close(); }
    } catch (error) { ctx.add(error instanceof Error && error.message === 'input-limit' ? 'input-limit' : 'metadata-unavailable', 'metadata', undefined, false); return []; }
    finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  }
  ctx.add('metadata-unstable', 'metadata', undefined, false);
  return [];
}
