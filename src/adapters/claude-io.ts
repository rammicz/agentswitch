import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { contains, ReadContext } from './codex-io.js';
export type NativeRecord = Record<string, unknown>;
export function object(value: unknown): NativeRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as NativeRecord : {};
}
export function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
export interface Entry extends NativeRecord { uuid: string; type: string; parentUuid: string | null; line: number }

/** Stream bounded lines; oversized/corrupt records cannot suppress later valid records. */
export async function records(path: string, root: string, ctx: ReadContext,
  accept: (value: NativeRecord, line: number) => void): Promise<number | undefined> {
  try {
    const canonical = await realpath(path);
    if (!contains(root, canonical)) throw new Error('unsafe-path');
    const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('read-failed');
      let offset = 0, line = 1, parts: Buffer[] = [], size = 0, oversized = false;
      const parse = (final: boolean): void => {
        if (!oversized && size > 0) {
          try {
            const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, size));
            if (raw.trim()) {
              const value: unknown = JSON.parse(raw);
              if (value === null || typeof value !== 'object' || Array.isArray(value)) ctx.add('unsupported-shape', 'history', line);
              else accept(value as NativeRecord, line);
            }
          } catch { ctx.add(final ? 'partial-record' : 'malformed-record', 'history', line); }
        }
        parts = []; size = 0; oversized = false; line++;
      };
      while (offset < info.size && offset < ctx.limits.maxFileBytes && ctx.remaining > 0) {
        const requested = Math.min(64 * 1024, info.size - offset, ctx.limits.maxFileBytes - offset, ctx.remaining);
        const buffer = Buffer.alloc(requested);
        const { bytesRead } = await handle.read(buffer, 0, requested, offset);
        ctx.bytes += bytesRead; offset += bytesRead;
        if (!bytesRead) break;
        let start = 0;
        while (start < bytesRead) {
          const next = buffer.indexOf(10, start), end = next < 0 ? bytesRead : next;
          if (!oversized) {
            const part = buffer.subarray(start, end);
            size += part.length;
            if (size > ctx.limits.maxLineBytes) {
              ctx.add('input-limit', 'history', line); parts = []; oversized = true;
            } else parts.push(part);
          }
          if (next < 0) break;
          parse(false); start = next + 1;
        }
      }
      if (offset < info.size) ctx.add('input-limit', 'history', line);
      else parse(true);
      return info.mtimeMs;
    } finally { await handle.close(); }
  } catch (error) {
    ctx.add(error instanceof Error && error.message === 'unsafe-path' ? 'unsafe-path' : 'read-failed');
    return undefined;
  }
}
