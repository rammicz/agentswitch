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
export interface CodexLimits {
  maxFiles: number; maxFileBytes: number; maxDecodedBytes: number; maxLineBytes: number;
  maxDepth: number; maxDiagnostics: number; maxMetadataBytes: number; maxScanBytes: number;
}
export const defaultLimits: CodexLimits = {
  maxFiles: 10_000, maxFileBytes: 32 * 1024 * 1024, maxDecodedBytes: 64 * 1024 * 1024,
  maxLineBytes: 1024 * 1024, maxDepth: 32, maxDiagnostics: 100,
  maxMetadataBytes: 64 * 1024 * 1024, maxScanBytes: 256 * 1024 * 1024,
};
export class ReadContext {
  readonly diagnostics: CodexDiagnostic[] = [];
  complete = true;
  bytes = 0;
  constructor(readonly limits: CodexLimits, private readonly notify?: (diagnostic: CodexDiagnostic) => void) {}
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
export async function boundedRead(path: string, root: string, limit: number): Promise<Buffer> {
  const canonical = await realpath(path);
  if (!contains(root, canonical)) throw new Error('unsafe-path');
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error('input-limit');
    const data = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit || offset > info.size) throw new Error('input-limit');
    return data.subarray(0, offset);
  } finally { await handle.close(); }
}
/** Discovery consumes only the first record, leaving transcript validation to lazy reads. */
export async function historyHeader(path: string, root: string, ctx: ReadContext): Promise<Buffer | undefined> {
  try {
    if (!path.endsWith('.zst')) {
      const canonical = await realpath(path);
      if (!contains(root, canonical)) throw new Error('unsafe-path');
      const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        if (!(await handle.stat()).isFile()) throw new Error('read-failed');
        const buffer = Buffer.alloc(ctx.limits.maxLineBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const end = buffer.subarray(0, bytesRead).indexOf(10);
        if (end < 0 && bytesRead > ctx.limits.maxLineBytes) throw new Error('input-limit');
        const header = buffer.subarray(0, end < 0 ? bytesRead : end + 1);
        ctx.bytes += header.length;
        if (ctx.bytes > ctx.limits.maxScanBytes) throw new Error('input-limit');
        return header;
      } finally { await handle.close(); }
    }
    const input = await boundedRead(path, root, ctx.limits.maxFileBytes);
    ctx.bytes += input.length;
    const stream = Readable.from([input]).pipe(createZstdDecompress());
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const value of stream) {
        const chunk = Buffer.from(value as Uint8Array), newline = chunk.indexOf(10);
        const part = newline < 0 ? chunk : chunk.subarray(0, newline + 1);
        size += part.length;
        if (size > ctx.limits.maxLineBytes || size > ctx.limits.maxDecodedBytes || ctx.bytes + size > ctx.limits.maxScanBytes) throw new Error('input-limit');
        chunks.push(part);
        if (newline >= 0) { ctx.bytes += size; return Buffer.concat(chunks, size); }
      }
      return Buffer.concat(chunks, size);
    } finally { stream.destroy(); }
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    ctx.add(code === 'unsafe-path' || code === 'input-limit' ? code : path.endsWith('.zst') ? 'compressed-invalid' : 'read-failed');
    return undefined;
  }
}
export async function historyBytes(path: string, root: string, ctx: ReadContext): Promise<Buffer | undefined> {
  try {
    const input = await boundedRead(path, root, ctx.limits.maxFileBytes);
    ctx.bytes += input.length;
    if (ctx.bytes > ctx.limits.maxScanBytes) throw new Error('input-limit');
    if (!path.endsWith('.zst')) {
      if (input.length > ctx.limits.maxDecodedBytes) throw new Error('input-limit');
      return input;
    }
    const stream = Readable.from([input]).pipe(createZstdDecompress());
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of stream) {
        const data = Buffer.from(chunk as Uint8Array);
        size += data.length;
        if (size > ctx.limits.maxDecodedBytes) throw new Error('input-limit');
        chunks.push(data);
      }
      ctx.bytes += size;
      if (ctx.bytes > ctx.limits.maxScanBytes) throw new Error('input-limit');
      return Buffer.concat(chunks, size);
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
      const copies = await Promise.all(files.map((file, index) => before[index] === 'absent' ? undefined : boundedRead(file, root, ctx.limits.maxMetadataBytes)));
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
    } catch { ctx.add('metadata-unavailable', 'metadata', undefined, false); return []; }
    finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  }
  ctx.add('metadata-unstable', 'metadata', undefined, false);
  return [];
}
