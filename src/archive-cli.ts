import { parseArgs } from 'node:util';
import { ArchiveError, deleteArchive, listArchive, readArchiveItem } from './archive.js';

/** Explicit offline utility. Arguments remain data; no shell or native provider is invoked. */
export async function runArchiveCommand(args: readonly string[]): Promise<string> {
  const invalid = (): never => { throw new ArchiveError('INVALID_COMMAND', 'Usage: agentswitch archive list|read|delete --directory <private-directory> --archive <id> [--item <ordinal>] [--cursor <offset>] [--limit <count>] [--max-bytes <bytes>]'); };
  const action = args[0];
  if (!['list', 'read', 'delete'].includes(action ?? '')) return invalid();
  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({ args: args.slice(1), options: { directory: { type: 'string' }, archive: { type: 'string' }, item: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'string' }, 'max-bytes': { type: 'string' } } }).values;
  } catch { return invalid(); }
  if (!values.directory || !values.archive || (action !== 'read' && values.item !== undefined) || (action !== 'list' && values.limit !== undefined) || (action === 'delete' && (values.cursor !== undefined || values['max-bytes'] !== undefined))) return invalid();
  const number = (name: string, fallback: number) => { const value = values[name]; if (value === undefined) return fallback; if (!/^\d{1,10}$/.test(value) || !Number.isSafeInteger(Number(value))) return invalid(); return Number(value); };
  const reference = { directory: values.directory, id: values.archive };
  if (action === 'delete') { await deleteArchive(reference); return JSON.stringify({ deleted: reference.id }); }
  const bytes = number('max-bytes', 8192);
  if (bytes < 1 || bytes > 65536) return invalid();
  // Leave one byte for the CLI's final newline; the complete stdout page obeys the requested cap.
  const paging = { ...reference, cursor: number('cursor', 0), maxBytes: bytes - 1 };
  if (action === 'list') return JSON.stringify(await listArchive({ ...paging, limit: number('limit', 50) }));
  if (values.item === undefined) return invalid();
  return JSON.stringify(await readArchiveItem({ ...paging, ordinal: number('item', 0) }));
}
