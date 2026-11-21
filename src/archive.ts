import { randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { HistoryItem } from './domain.js';
import type { SessionSource } from './tui/contracts.js';

export interface ArchiveReference { directory: string; id: string }
export interface ArchiveSnapshot {
  source: SessionSource;
  items: readonly HistoryItem[];
  includedItemIds: readonly string[];
  /** Describes only the caller's supplied public snapshot, never raw native completeness. */
  completeness: 'complete' | 'partial' | 'unknown';
}
interface StoredArchive extends ArchiveSnapshot { version: 1; id: string }
export class ArchiveError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ArchiveError'; }
}
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_PAGE_BYTES = 64 * 1024;
const marker = 'agentswitch-public-archive-v1\n';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const filenamePattern = /^[0-9a-f-]{36}\.json$|^[0-9a-f-]{36}\.[0-9a-f-]{36}\.tmp$|^[0-9a-f-]{36}\.pin$/;
function failure(code: string, message: string): never { throw new ArchiveError(code, message); }
export function wellFormed(value: string): boolean { return !/[\uD800-\uDFFF]/u.test(value); }
export function archiveId(id: string): string {
  if (typeof id !== 'string' || !idPattern.test(id)) failure('INVALID_REFERENCE', 'Invalid archive reference.');
  return id;
}
function publicString(value: unknown, maxBytes = MAX_ARCHIVE_BYTES): string {
  if (typeof value !== 'string' || !wellFormed(value) || value.includes('\0') || Buffer.byteLength(value) > maxBytes) failure('INVALID_HISTORY', 'Invalid public history field.');
  return value;
}
/** Copy only the approved public schema. Never retain unknown native/account fields. */
export function publicSnapshot(snapshot: ArchiveSnapshot): ArchiveSnapshot {
  if (!snapshot || !snapshot.source || !['codex', 'claude'].includes(snapshot.source.agent) || !Array.isArray(snapshot.items) || snapshot.items.length > 100000 || !Array.isArray(snapshot.includedItemIds) || !['complete', 'partial', 'unknown'].includes(snapshot.completeness)) failure('INVALID_HISTORY', 'Invalid public history snapshot.');
  const source: SessionSource = { agent: snapshot.source.agent, id: publicString(snapshot.source.id, 4096), nativeId: publicString(snapshot.source.nativeId, 4096) };
  const ids = new Set<string>(); let bytes = 0;
  const items = snapshot.items.map(item => {
    if (!item || !['user', 'assistant', 'tool'].includes(item.role) || !['complete', 'interrupted', 'failed'].includes(item.status)) failure('INVALID_HISTORY', 'Invalid public history item.');
    const id = publicString(item.id, 4096); const text = publicString(item.text);
    if (!id || ids.has(id)) failure('DUPLICATE_ITEM', 'Public history has an empty or duplicate item ID.');
    ids.add(id); bytes += Buffer.byteLength(id) + Buffer.byteLength(text);
    if (bytes > MAX_ARCHIVE_BYTES) failure('ARCHIVE_TOO_LARGE', 'Public history exceeds the supported archive size.');
    return { id, role: item.role, text, status: item.status };
  });
  const includedItemIds = snapshot.includedItemIds.map(id => publicString(id, 4096));
  if (new Set(includedItemIds).size !== includedItemIds.length || includedItemIds.some(id => !ids.has(id))) failure('INVALID_HISTORY', 'Invalid included history IDs.');
  return { source, items, includedItemIds, completeness: snapshot.completeness };
}
function privateEntry(info: Stats, directory: boolean): void {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) failure('UNSAFE_ARCHIVE', 'Archive storage must be private and owned, without symbolic links.');
}
async function privateRead(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat(); privateEntry(info, false);
    if (info.size > maxBytes) failure('ARCHIVE_TOO_LARGE', 'Archive file exceeds the supported size.');
    // Read at most the validated limit even if a concurrent writer grows the file.
    const data = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let offset = 0;
    while (offset < data.length) { const result = await handle.read(data, offset, data.length - offset, null); if (!result.bytesRead) break; offset += result.bytesRead; }
    if (offset > maxBytes || offset > info.size) failure('CORRUPT_ARCHIVE', 'Archive changed during retrieval.');
    const bytes = data.subarray(0, offset);
    if (!isUtf8(bytes)) failure('CORRUPT_ARCHIVE', 'Archive contains invalid UTF-8.');
    return bytes.toString('utf8');
  } finally { await handle.close(); }
}
async function root(directory: string, create: boolean): Promise<{ directory: string; identity: Stats }> {
  if (typeof directory !== 'string' || !directory || directory.includes('\0')) failure('INVALID_REFERENCE', 'Invalid archive directory.');
  const requested = resolve(directory);
  if (create) { try { await mkdir(requested, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
  privateEntry(await lstat(requested), true);
  // Parent aliases such as macOS /var -> /private/var are valid; the chosen leaf is never a symlink.
  const canonical = await realpath(requested); const identity = await lstat(canonical); privateEntry(identity, true);
  const entries = await readdir(canonical);
  if (entries.length > 100000 || entries.some(name => name !== 'owner' && !filenamePattern.test(name))) failure('UNSAFE_ARCHIVE', 'Use a dedicated agentswitch archive directory.');
  if (create && entries.length === 0) {
    try { const handle = await open(join(canonical, 'owner'), 'wx', 0o600); try { await handle.writeFile(marker); await handle.sync(); } finally { await handle.close(); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  if (await privateRead(join(canonical, 'owner'), 128) !== marker) failure('UNSAFE_ARCHIVE', 'Archive directory has an invalid ownership marker.');
  for (const name of entries) {
    try { privateEntry(await lstat(join(canonical, name)), false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return { directory: canonical, identity };
}
async function unchanged(directory: string, identity: Stats): Promise<void> {
  const info = await lstat(directory); privateEntry(info, true);
  if (info.ino !== identity.ino || info.dev !== identity.dev) failure('UNSAFE_ARCHIVE', 'Archive directory was replaced.');
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } catch (error) {
    if (process.platform !== 'darwin' || !['EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally { await handle.close(); }
}
async function controlled<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof ArchiveError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') failure('MISSING_ARCHIVE', 'Archive or item is missing or deleted.');
    if (code === 'EEXIST') failure('ARCHIVE_EXISTS', 'Archive reference already exists; prepare a new handoff.');
    failure('ARCHIVE_IO', 'Archive storage is inaccessible or unsafe.');
  }
}
/** Publish complete private data without replacing an existing immutable reference. */
export async function publishArchive(reference: ArchiveReference, input: ArchiveSnapshot): Promise<ArchiveReference> {
  return controlled(async () => {
    const id = archiveId(reference.id); const snapshot = publicSnapshot(input);
    const serialized = JSON.stringify({ version: 1, id, ...snapshot });
    if (Buffer.byteLength(serialized) > MAX_ARCHIVE_BYTES) failure('ARCHIVE_TOO_LARGE', 'Public history exceeds the supported archive size.');
    const { directory, identity } = await root(reference.directory, true);
    const temporary = join(directory, `${id}.${randomUUID()}.tmp`); const destination = join(directory, `${id}.json`);
    let published = false;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(serialized); await handle.sync(); await handle.close();
      await unchanged(directory, identity);
      // Hard-link publication is atomic and exclusive on Linux/macOS; rename would overwrite a collision.
      await link(temporary, destination); published = true;
      await unlink(temporary); await syncDirectory(directory); await unchanged(directory, identity);
      return { directory, id };
    } catch (error) {
      await handle.close().catch(() => {});
      if (published) await unlink(destination).catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  });
}
async function load(reference: ArchiveReference): Promise<StoredArchive> {
  const id = archiveId(reference.id); const { directory, identity } = await root(reference.directory, false);
  const serialized = await privateRead(join(directory, `${id}.json`), MAX_ARCHIVE_BYTES);
  await unchanged(directory, identity);
  let data: StoredArchive;
  try { data = JSON.parse(serialized) as StoredArchive; } catch { return failure('CORRUPT_ARCHIVE', 'Archive is corrupt.'); }
  if (!data || data.version !== 1) failure('UNSUPPORTED_ARCHIVE', 'Unsupported archive version.');
  if (data.id !== id) failure('CORRUPT_ARCHIVE', 'Archive reference does not match its content.');
  try { return { version: 1, id, ...publicSnapshot(data) }; } catch { return failure('CORRUPT_ARCHIVE', 'Archive public history is corrupt.'); }
}
function integer(value: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) failure('INVALID_PAGE', `Invalid archive ${label}.`);
  return value;
}
function pageBytes(value = 8192): number { return integer(value, MAX_PAGE_BYTES, 'page byte budget'); }
function fits(page: unknown, maxBytes: number): boolean { return Buffer.byteLength(JSON.stringify(page)) <= maxBytes; }
export interface ManifestPageOptions extends ArchiveReference { cursor?: number; limit?: number; maxBytes?: number }
export async function listArchive(options: ManifestPageOptions) {
  return controlled(async () => {
    const cursor = integer(options.cursor ?? 0, 100000, 'cursor'); const limit = integer(options.limit ?? 50, 1000, 'limit'); const maxBytes = pageBytes(options.maxBytes);
    if (limit === 0) failure('INVALID_PAGE', 'Archive page limit must be positive.');
    const data = await load(options);
    if (cursor > data.items.length) failure('INVALID_PAGE', 'Archive cursor is past the end.');
    const included = new Set(data.includedItemIds);
    const page = { archiveId: data.id, source: data.source, completeness: data.completeness, items: [] as { ordinal: number; id: string; role: HistoryItem['role']; status: HistoryItem['status']; included: boolean }[], nextCursor: cursor < data.items.length ? cursor as number | null : null };
    for (let ordinal = cursor; ordinal < data.items.length && page.items.length < limit; ordinal++) {
      const item = data.items[ordinal]!;
      const entry = { ordinal, id: item.id, role: item.role, status: item.status, included: included.has(item.id) };
      page.items.push(entry); page.nextCursor = ordinal + 1 < data.items.length ? ordinal + 1 : null;
      if (!fits(page, maxBytes)) { page.items.pop(); page.nextCursor = ordinal; break; }
    }
    if (!fits(page, maxBytes) || (!page.items.length && cursor < data.items.length)) failure('PAGE_TOO_SMALL', 'Archive page byte budget is too small for the next entry.');
    return page;
  });
}
export interface ItemPageOptions extends ArchiveReference { ordinal: number; cursor?: number; maxBytes?: number }
/** Text cursors are UTF-16 offsets at Unicode scalar boundaries; pages reconstruct exact text. */
export async function readArchiveItem(options: ItemPageOptions) {
  return controlled(async () => {
    const ordinal = integer(options.ordinal, 99999, 'item ordinal'); const cursor = integer(options.cursor ?? 0, MAX_ARCHIVE_BYTES, 'cursor'); const maxBytes = pageBytes(options.maxBytes);
    const data = await load(options); const item = data.items[ordinal];
    if (!item) failure('MISSING_ITEM', 'Archive item is missing or deleted.');
    const boundary = (offset: number) => offset === 0 || offset === item.text.length || !(item.text.charCodeAt(offset) >= 0xdc00 && item.text.charCodeAt(offset) <= 0xdfff);
    if (cursor > item.text.length || !boundary(cursor)) failure('INVALID_PAGE', 'Archive cursor is not a valid text boundary.');
    const page = { archiveId: data.id, ordinal, id: item.id, role: item.role, status: item.status, text: '', nextCursor: cursor < item.text.length ? cursor as number | null : null };
    // Bound the search window before serializing; never split a Unicode scalar.
    const atBoundary = (offset: number) => boundary(offset) ? offset : offset - 1;
    const candidate = (end: number) => ({ ...page, text: item.text.slice(cursor, end), nextCursor: end < item.text.length ? end : null });
    let low = cursor; let high = atBoundary(Math.min(item.text.length, cursor + maxBytes));
    if (fits(candidate(high), maxBytes)) low = high;
    else while (low < high) {
      let middle = atBoundary(Math.ceil((low + high) / 2));
      if (middle <= low) middle = low + (item.text.codePointAt(low)! > 0xffff ? 2 : 1);
      if (fits(candidate(middle), maxBytes)) low = middle;
      else high = atBoundary(middle - 1);
    }
    const result = candidate(low);
    if (!fits(result, maxBytes) || (low === cursor && cursor < item.text.length)) failure('PAGE_TOO_SMALL', 'Archive page byte budget is too small for the next character.');
    return result;
  });
}
/** Delete this archive and its crash leftovers only; never recursively remove a caller directory. */
export async function deleteArchive(reference: ArchiveReference): Promise<void> {
  return controlled(async () => {
    const id = archiveId(reference.id); const { directory, identity } = await root(reference.directory, false);
    if ((await readdir(directory)).includes(`${id}.pin`)) failure('ACTIVE_ARCHIVE', 'Archive is reserved by a transfer whose writer may still be active. Use transfer recovery after its supervised writer stops.');
    const entries = (await readdir(directory)).filter(name => name === `${id}.json` || (name.startsWith(`${id}.`) && name.endsWith('.tmp')));
    if (!entries.length) failure('MISSING_ARCHIVE', 'Archive is missing or deleted.');
    for (const name of entries) { await unchanged(directory, identity); privateEntry(await lstat(join(directory, name)), false); await unlink(join(directory, name)); }
    await syncDirectory(directory);
  });
}

/** Durable archive use reservation. A crashed launcher never loses this protection automatically. */
export async function protectArchive(reference: ArchiveReference, token: string): Promise<void> {
  return controlled(async () => {
    archiveId(token); const id=archiveId(reference.id); const {directory}=await root(reference.directory,false);
    const handle=await open(join(directory,`${id}.pin`),'wx',0o600);
    try { await handle.writeFile(token);await handle.sync(); } finally {await handle.close();}
    await syncDirectory(directory);
  });
}
/** Only the owning transfer can release a reservation after proving its supervised writer stopped. */
export async function releaseArchive(reference: ArchiveReference, token: string): Promise<void> {
  return controlled(async () => {
    archiveId(token);const id=archiveId(reference.id);const {directory}=await root(reference.directory,false);
    if(await privateRead(join(directory,`${id}.pin`),128)!==token) failure('ACTIVE_ARCHIVE','Archive reservation belongs to another transfer.');
    await unlink(join(directory,`${id}.pin`));await syncDirectory(directory);
  });
}
/** Validated redacted snapshot for deliberate recovery, never an executable launch plan. */
export async function readArchiveSnapshot(reference: ArchiveReference): Promise<ArchiveSnapshot> {
  return controlled(async()=>publicSnapshot(await load(reference)));
}
