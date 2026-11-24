import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { contains, ReadContext } from './codex-io.js';
export type NativeRecord = Record<string, unknown>;
export function object(value: unknown): NativeRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as NativeRecord : {};
}
export function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
export interface Entry extends NativeRecord { uuid: string; type: string; parentUuid: string | null; line: number }
/** Line numbers are unknown inside a tail window. */
type Accept = (value: NativeRecord, line: number | undefined) => void;
const chunk = 64 * 1024;

async function withFile(path: string, root: string, ctx: ReadContext,
  read: (handle: FileHandle, size: number) => Promise<unknown>): Promise<number | undefined> {
  try {
    const canonical = await realpath(path);
    if (!contains(root, canonical)) throw new Error('unsafe-path');
    const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('read-failed');
      await read(handle, info.size);
      return info.mtimeMs;
    } finally { await handle.close(); }
  } catch (error) {
    ctx.add(error instanceof Error && error.message === 'unsafe-path' ? 'unsafe-path' : 'read-failed');
    return undefined;
  }
}

/**
 * Parse the lines of [start, end) and return where the first unparsed line starts (`size` at EOF). A window starting
 * mid-file skips its cut first line. Stopping at a window end or at `until` (checked per chunk) drops the cut last line
 * silently; running out of byte budget, or a file cap when not a window, is `input-limit`.
 */
async function scan(handle: FileHandle, size: number, ctx: ReadContext, accept: Accept, start: number, end: number,
  window: boolean, until?: () => boolean): Promise<number> {
  let line = start ? undefined : 1, parts: Buffer[] = [], length = 0, oversized = false, stopped = false;
  // Reading from the byte before `start` tells whether the window opens on a line boundary.
  let offset = start ? start - 1 : 0, skipping = start > 0, resume = start;
  const parse = (final: boolean): void => {
    if (!oversized && length > 0) {
      try {
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, length));
        if (raw.trim()) {
          const value: unknown = JSON.parse(raw);
          if (value === null || typeof value !== 'object' || Array.isArray(value)) ctx.add('unsupported-shape', 'history', line);
          else accept(value as NativeRecord, line);
        }
      } catch { ctx.add(final ? 'partial-record' : 'malformed-record', 'history', line); }
    }
    parts = []; length = 0; oversized = false; if (line !== undefined) line++;
  };
  while (offset < end && ctx.remaining > 0) {
    if (until?.()) { stopped = true; break; }
    const requested = Math.min(chunk, end - offset, ctx.remaining), at = offset;
    const buffer = Buffer.alloc(requested);
    const { bytesRead } = await handle.read(buffer, 0, requested, offset);
    ctx.bytes += bytesRead; offset += bytesRead;
    if (!bytesRead) break;
    let begin = 0;
    if (skipping) {
      const next = buffer.indexOf(10);
      if (next < 0) continue;
      skipping = false; begin = next + 1; resume = at + begin;
    }
    while (begin < bytesRead) {
      const next = buffer.indexOf(10, begin), stop = next < 0 ? bytesRead : next;
      if (!oversized) {
        const part = buffer.subarray(begin, stop);
        length += part.length;
        if (length > ctx.limits.maxLineBytes) {
          ctx.add('input-limit', 'history', line); parts = []; oversized = true;
        } else parts.push(part);
      }
      if (next < 0) break;
      parse(false); begin = next + 1; resume = at + begin;
    }
  }
  if (offset >= size) { parse(true); return size; }
  if (!stopped && !(window && offset >= end)) ctx.add('input-limit', 'history', line);
  return resume;
}

/** Stream bounded lines; oversized/corrupt records cannot suppress later valid records. */
export function records(path: string, root: string, ctx: ReadContext, accept: (value: NativeRecord, line: number) => void,
  maxBytes = ctx.limits.maxFileBytes): Promise<number | undefined> {
  return withFile(path, root, ctx, (handle, size) =>
    scan(handle, size, ctx, (value, line) => accept(value, line!), 0, Math.min(size, maxBytes), false));
}

/**
 * Discovery metadata without reading whole transcripts: a head window read until `enough` (at most one maximal line
 * past its first chunk) plus the last chunk, where title updates are appended. The tail resumes where the head
 * stopped when they meet, so no line is skipped or read twice.
 */
export function metadataRecords(path: string, root: string, ctx: ReadContext, accept: Accept,
  enough: () => boolean): Promise<number | undefined> {
  return withFile(path, root, ctx, async (handle, size) => {
    const { maxFileBytes, maxLineBytes } = ctx.limits, head = Math.min(maxFileBytes, maxLineBytes + chunk);
    const resume = await scan(handle, size, ctx, accept, 0, Math.min(size, head), true, enough);
    // The tail read includes one byte before its window; together both windows stay within maxFileBytes.
    const tail = Math.min(chunk, maxFileBytes - head - 1);
    if (resume < size && tail > 0 && ctx.remaining > 0) await scan(handle, size, ctx, accept, Math.max(resume, size - tail), size, true);
  });
}
