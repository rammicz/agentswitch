import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishArchive, listArchive, readArchiveItem, deleteArchive } from '../dist/archive.js';
import { prepareHandoff } from '../dist/handoff.js';

const source = { agent: 'claude', id: 'session', nativeId: 'native' };
const id = '22222222-2222-4222-8222-222222222222';
const snapshot = { source, items: [{ id: 'unicode', role: 'tool', status: 'interrupted', text: ('😀é漢\\"\n\u0001').repeat(2000) }], includedItemIds: [], completeness: 'partial' };
async function temporary(t) { const parent = await mkdtemp(join(tmpdir(), 'agentswitch-archive-')); t.after(() => rm(parent, { recursive: true, force: true })); return { parent, directory: join(parent, 'archives with spaces $()') }; }
const cli = (...args) => spawnSync(process.execPath, ['dist/cli.js', 'archive', ...args], { encoding: 'utf8', maxBuffer: 100000 });
const flags = ref => ['--directory', ref.directory, '--archive', ref.id];

test('fresh CLI processes retrieve all omitted text with bounded UTF-8 pages and delete references', async t => {
  const { directory } = await temporary(t);
  const prepared = await prepareHandoff({ directory, source, items: snapshot.items, currentRequest: 'continue', maxBytes: 1800, completeness: 'partial' });
  const ref = prepared.archive;
  const manifest = cli('list', ...flags(ref), '--max-bytes', '512', '--limit', '1');
  assert.equal(manifest.status, 0, manifest.stderr);
  assert.ok(Buffer.byteLength(manifest.stdout) <= 512);
  assert.equal(JSON.parse(manifest.stdout).items[0].included, false);
  assert.equal(JSON.parse(manifest.stdout).completeness, 'partial');
  let cursor = 0; let text = ''; let count = 0;
  do {
    const result = cli('read', ...flags(ref), '--item', '0', '--cursor', String(cursor), '--max-bytes', '8192');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout) <= 8192);
    const page = JSON.parse(result.stdout); text += page.text; count++;
    assert.ok(page.nextCursor === null || page.nextCursor > cursor);
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.ok(count > 2);
  assert.equal(text, snapshot.items[0].text);
  const deleted = cli('delete', ...flags(ref));
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.equal(cli('list', ...flags(ref)).status, 1);
  assert.match(cli('read', ...flags(ref), '--item', '0').stderr, /missing|deleted/i);
});

test('private publication is exclusive under permissive umask and cleans only owned artifacts', async t => {
  const { directory } = await temporary(t); const ref = { directory, id };
  const previous = process.umask(0);
  try { await publishArchive(ref, snapshot); } finally { process.umask(previous); }
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const name of await readdir(directory)) assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
  const original = await readFile(join(directory, `${id}.json`), 'utf8');
  await assert.rejects(publishArchive(ref, { ...snapshot, items: [] }), /already exists/);
  assert.equal(await readFile(join(directory, `${id}.json`), 'utf8'), original);
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), []);
  await writeFile(join(directory, `${id}.33333333-3333-4333-8333-333333333333.tmp`), 'orphan private public text', { mode: 0o600 });
  await deleteArchive(ref);
  assert.deepEqual(await readdir(directory), ['owner']);
  await assert.rejects(deleteArchive(ref), /missing|deleted/);
});

test('reject unsafe storage, traversal, unknown entries, symlinks and public permissions without takeover', async t => {
  const { parent, directory } = await temporary(t);
  await mkdir(directory, { mode: 0o755 });
  await assert.rejects(publishArchive({ directory, id }, snapshot), /private/);
  assert.equal((await stat(directory)).mode & 0o777, 0o755);
  const target = join(parent, 'target'); await mkdir(target, { mode: 0o700 });
  const alias = join(parent, 'alias'); await symlink(target, alias);
  await assert.rejects(publishArchive({ directory: alias, id }, snapshot), /private/);
  assert.deepEqual(await readdir(target), []);
  const foreign = join(parent, 'foreign'); await mkdir(foreign, { mode: 0o700 });
  await writeFile(join(foreign, 'valuable'), 'unchanged', { mode: 0o600 });
  await assert.rejects(publishArchive({ directory: foreign, id }, snapshot), /dedicated/);
  assert.equal(await readFile(join(foreign, 'valuable'), 'utf8'), 'unchanged');
  for (const bad of ['../outside', '/absolute', '', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA']) await assert.rejects(listArchive({ directory, id: bad }), /Invalid archive reference/);
  const safe = join(parent, 'safe'); await publishArchive({ directory: safe, id }, snapshot);
  await rm(join(safe, `${id}.json`));
  await symlink(join(foreign, 'valuable'), join(safe, `${id}.json`));
  await assert.rejects(readArchiveItem({ directory: safe, id, ordinal: 0 }), /private|unsafe/);
  await assert.rejects(deleteArchive({ directory: safe, id }), /private|unsafe/);
  assert.equal(await readFile(join(foreign, 'valuable'), 'utf8'), 'unchanged');
});

test('bounded corruption, version, cursor and missing-item errors never echo retained data', async t => {
  const { directory } = await temporary(t); const ref = { directory, id };
  await publishArchive(ref, snapshot);
  for (const options of [{ ordinal: 1 }, { ordinal: -1 }, { ordinal: 0, cursor: 1 }, { ordinal: 0, cursor: 999999 }, { ordinal: 0, maxBytes: 1 }, { ordinal: 0, maxBytes: 65537 }, { ordinal: 0, cursor: 1.5 }]) await assert.rejects(readArchiveItem({ ...ref, ...options }), /missing|Invalid|small|boundary/);
  for (const options of [{ limit: 0 }, { cursor: -1 }, { cursor: 2 }, { limit: 1001 }, { maxBytes: 1 }]) await assert.rejects(listArchive({ ...ref, ...options }), /Invalid|small|positive|past/);
  for (const content of ['PRIVATE_PARSE_SENTINEL{', JSON.stringify({ version: 99 }), JSON.stringify({ version: 1, id, source, items: [{ secret: 'PRIVATE_PARSE_SENTINEL' }], includedItemIds: [], completeness: 'unknown' })]) {
    await writeFile(join(directory, `${id}.json`), content);
    const result = cli('list', ...flags(ref));
    assert.equal(result.status, 1);
    assert.ok(result.stderr.length < 500);
    assert.ok(!result.stderr.includes('PRIVATE_PARSE_SENTINEL'));
  }
  for (const args of [['read', ...flags(ref)], ['list', ...flags(ref), '--cursor', '-1'], ['delete', ...flags(ref), '--limit', '1'], ['list', ...flags(ref), '--max-bytes', '1e3'], ['list', ...flags(ref), '--evil-secret-flag']]) {
    const result = cli(...args); assert.equal(result.status, 1); assert.ok(result.stderr.length < 500);
    assert.ok(!result.stderr.includes('evil-secret'));
  }
});

test('a killed partial writer leaves no complete reference and deletion removes its private orphan', async t => {
  const { directory } = await temporary(t);
  // Patch only the test child's file write to interrupt the actual publication path after a prefix.
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const originalOpen = fs.promises.open;
    fs.promises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith('.tmp')) handle.writeFile = async text => {
        await handle.write(String(text).slice(0, 37));
        process.kill(process.pid, 'SIGKILL');
        await new Promise(() => {});
      };
      return handle;
    };
    syncBuiltinESMExports();
    const { publishArchive } = await import('./dist/archive.js');
    await publishArchive(JSON.parse(process.argv[1]), JSON.parse(process.argv[2]));
  `;
  const ref = { directory, id };
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(ref), JSON.stringify(snapshot)], { encoding: 'utf8' });
  assert.equal(result.signal, 'SIGKILL', result.stderr);
  const entries = await readdir(directory);
  assert.equal(entries.filter(name => name.endsWith('.json')).length, 0);
  const orphan = entries.find(name => name.endsWith('.tmp'));
  assert.ok(orphan);
  assert.equal((await stat(join(directory, orphan))).mode & 0o777, 0o600);
  await assert.rejects(listArchive(ref), /missing|deleted/);
  await deleteArchive(ref);
  assert.deepEqual(await readdir(directory), ['owner']);
});

test('parent path aliases work but archive leaf aliases remain rejected', async t => {
  const { parent } = await temporary(t);
  const actual = join(parent, 'actual'); await mkdir(actual, { mode: 0o700 });
  const alias = join(parent, 'parent-alias'); await symlink(actual, alias);
  const reference = { directory: join(alias, 'archives'), id };
  await publishArchive(reference, snapshot);
  assert.equal((await listArchive(reference)).items[0].id, 'unicode');
  await deleteArchive(reference);
});

test('T4: startup expiry deletes unpinned archives older than 30 days, oldest first and bounded, and marks them expired in the journal', async t => {
  const { expireArchives } = await import('../dist/application.js');
  const { TransferJournal } = await import('../dist/transfer-journal.js');
  const { protectArchive } = await import('../dist/archive.js');
  const { utimes, writeFile: write } = await import('node:fs/promises');
  const { parent, directory } = await temporary(t);
  const journal = await TransferJournal.open(join(parent, 'journal')); t.after(() => journal.close());
  const now = Date.parse('2026-11-24T12:00:00Z'), day = 86400000;
  const uuid = n => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
  const age = async (name, days) => { const time = new Date(now - days * day); await utimes(join(directory, name), time, time); };
  const intent = archive => ({ source, sourceKey: 'root+source', target: 'codex', workspace: '/synthetic', mode: 'fresh-handoff', prompt: 'approved', includedItemIds: [], omittedItemIds: ['unicode'], archive, completeness: 'partial' });
  const make = async (n, days, recorded = true) => {
    const ref = await publishArchive({ directory, id: uuid(n) }, snapshot); await age(`${ref.id}.json`, days);
    return { ref, record: recorded ? journal.prepare(intent(ref)) : undefined };
  };
  const old = await make(1, 31), pinned = await make(2, 45), fresh = await make(3, 29), orphan = await make(4, 60, false);
  await protectArchive(pinned.ref, pinned.record.id);
  const leftover = `${uuid(5)}.${uuid(6)}.tmp`; await write(join(directory, leftover), 'partial', { mode: 0o600 }); await age(leftover, 40);
  assert.deepEqual(await expireArchives(directory, journal, now, 1), [orphan.ref.id]);
  assert.deepEqual(await expireArchives(directory, journal, now), [uuid(5), old.ref.id]);
  assert.deepEqual((await readdir(directory)).sort(), ['owner', `${pinned.ref.id}.json`, `${pinned.ref.id}.pin`, `${fresh.ref.id}.json`].sort());
  const expired = journal.get(old.record.id);
  assert.equal(expired.archiveExpiredAt, new Date(now).toISOString());
  assert.deepEqual(expired.archive, old.ref);
  for (const kept of [pinned, fresh]) assert.equal(journal.get(kept.record.id).archiveExpiredAt, undefined);
  assert.deepEqual(await expireArchives(directory, journal, now), []);
  // A state directory without archives is left alone.
  assert.deepEqual(await expireArchives(join(parent, 'never created'), journal, now), []);
  await assert.rejects(readdir(join(parent, 'never created')), { code: 'ENOENT' });
});
