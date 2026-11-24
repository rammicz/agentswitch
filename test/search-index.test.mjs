import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, realpath, rm, stat, symlink, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SearchIndex } from '../dist/search-index.js';
import { tempDir } from './fixtures/temp.mjs';

const query = (text = '', agent = 'all', scope = 'global', workspace = '/') => ({ text, agent, scope, workspace });
const ids = (hits) => hits.map((hit) => hit.id);
async function fixture(t, options = {}) {
  const root = await realpath(await tempDir('agentswitch-index-'));
  for (const path of ['project', 'project/child', 'project-other', 'elsewhere']) await mkdir(join(root, path), { recursive: true });
  await symlink(join(root, 'project'), join(root, 'alias'));
  const rows = new Map();
  const calls = { discover: 0, history: 0 };
  const sources = ['codex', 'claude'].map((agent) => ({ sourceId: `${agent}-fixture`, adapter: {
    id: agent,
    async discover() { calls.discover++; return [...rows.values()].filter((x) => x.agent === agent).map(({ messages, ...x }) => ({ ...x, messages: [] })); },
    async readHistory(nativeId) { calls.history++; return rows.get(`${agent}/${nativeId}`).messages; },
  } }));
  function add(agent, nativeId, workspace = 'project', text = 'sapphire-needle', extra = {}) {
    rows.set(`${agent}/${nativeId}`, { id: `${agent}:${nativeId}`, agent, nativeId, title: `Session ${nativeId}`, workspace: join(root, workspace), updatedAt: '2026-01-01T00:00:00Z', messages: [{ id: 'm1', role: 'assistant', status: 'complete', text }], ...extra });
  }
  const directory = join(root, 'cache');
  const index = await SearchIndex.open({ directory, sources, ...options });
  t.after(() => index.close());
  return { root, rows, sources, calls, add, directory, index };
}

test('F1: hydrates public histories and returns provider/item provenance and literal bounded excerpts', async (t) => {
  const f = await fixture(t);
  f.add('codex', 'same'); f.add('claude', 'same');
  f.add('codex', 'long', 'elsewhere', `${'x'.repeat(10000)} 💎 SAPPHIRE-NEEDLE end`);
  f.add('codex', 'split', 'project', 'alpha', { messages: [
    { id: 'a', role: 'user', status: 'complete', text: 'alpha' }, { id: 'b', role: 'tool', status: 'complete', text: 'beta' },
  ] });
  await f.index.refresh();
  assert.equal(f.calls.history, 4);
  for (const agent of ['all', 'codex', 'claude']) {
    const hits = await f.index.query(query('sapphire-needle', agent));
    assert.deepEqual(ids(hits), agent === 'all' ? ['claude:same', 'codex:long', 'codex:same'] : agent === 'codex' ? ['codex:long', 'codex:same'] : ['claude:same']);
    for (const hit of hits) {
      assert.equal('messages' in hit, false);
      assert.equal(hit.matches[0].field, 'message'); assert.equal(hit.matches[0].itemId, 'm1');
      assert.equal(hit.matches[0].role, 'assistant'); assert.match(hit.matches[0].text.toLowerCase(), /sapphire-needle/);
      assert.ok([...hit.matches[0].text].length <= 242);
    }
  }
  assert.deepEqual(ids(await f.index.query(query('alpha\nbeta'))), []);
  assert.equal((await f.index.query(query('Session same', 'claude')))[0].matches[0].field, 'title');
  assert.equal((await f.index.query(query(f.root, 'claude')))[0].matches[0].field, 'workspace');
  for (const literal of ['100%', '_', '*', '"', 'a:b', 'OR', 'NEAR(x)', '[x]', 'a.b', '\\', "x' OR 1=1 --", 'é💎', 'İ']) {
    f.add('codex', 'literal', 'project', literal);
    await f.index.refresh('codex');
    assert.ok(ids(await f.index.query(query(literal, 'codex'))).includes('codex:literal'), literal);
  }
  assert.equal((await f.index.query(query('   '))).length, 5);
  const hits = await f.index.query(query('Session')); hits[0].title = 'tampered';
  assert.notEqual((await f.index.query(query('Session')))[0].title, 'tampered');
});

test('F2: exact canonical scope, configured sources, and deterministic recent-first total order', async (t) => {
  const f = await fixture(t);
  for (const agent of ['codex', 'claude']) for (const folder of ['project', 'project/child', 'project-other', 'elsewhere']) f.add(agent, folder, folder);
  f.add('codex', 'alias', 'alias', 'sapphire-needle', { updatedAt: '2026-02-01T00:00:00Z' });
  await f.index.refresh();
  for (const agent of ['all', 'codex', 'claude']) {
    const expected = agent === 'all' ? ['codex:alias', 'claude:project', 'codex:project'] : agent === 'codex' ? ['codex:alias', 'codex:project'] : ['claude:project'];
    for (const folder of ['project', 'alias']) assert.deepEqual(ids(await f.index.query(query('', agent, 'folder', join(f.root, folder)))), expected);
    assert.equal((await f.index.query(query('', agent))).length, agent === 'all' ? 9 : agent === 'codex' ? 5 : 4);
  }
  f.add('claude', 'missing', 'deleted'); await f.index.refresh('claude');
  assert.deepEqual(ids(await f.index.query(query('', 'all', 'folder', join(f.root, 'deleted')))), ['claude:missing']);
  await f.index.close();
  const reopened = await SearchIndex.open({ directory: f.directory, sources: [f.sources[0]] }); t.after(() => reopened.close());
  assert.equal((await reopened.query(query())).length, 5);
  const changedRoot = await SearchIndex.open({ directory: f.directory, sources: [{ ...f.sources[0], sourceId: 'different-root' }] }); t.after(() => changedRoot.close());
  assert.deepEqual(await changedRoot.query(query()), []);
});

test('F3: persistence, replacement at unchanged timestamps, provider deletion, rollback, rebuild and private purge', async (t) => {
  const f = await fixture(t);
  f.add('codex', 'same'); f.add('claude', 'same');
  await f.index.refresh(); await f.index.close();
  const offlineSources = f.sources.map(({ sourceId, adapter }) => ({ sourceId, adapter: { id: adapter.id, discover() { throw Error('offline'); }, readHistory() { throw Error('offline'); } } }));
  const offline = await SearchIndex.open({ directory: f.directory, sources: offlineSources });
  assert.deepEqual(ids(await offline.query(query('sapphire'))), ['claude:same', 'codex:same']); await offline.close();
  const index = await SearchIndex.open({ directory: f.directory, sources: f.sources }); t.after(() => index.close());
  f.add('codex', 'same', 'elsewhere', 'replacement', { title: 'Changed' }); f.add('codex', 'append', 'project', 'new item');
  await index.refresh('codex');
  assert.deepEqual(ids(await index.query(query('sapphire'))), ['claude:same']);
  assert.deepEqual(ids(await index.query(query('replacement'))), ['codex:same']);
  f.rows.delete('codex/append'); await index.refresh('codex');
  assert.deepEqual(ids(await index.query(query())), ['claude:same', 'codex:same']);
  const oldRead = f.sources[0].adapter.readHistory; f.sources[0].adapter.readHistory = () => { throw Error('injected failure'); };
  await assert.rejects(index.refresh(), /injected failure/);
  assert.deepEqual(ids(await index.query(query())), ['claude:same', 'codex:same']); f.sources[0].adapter.readHistory = oldRead;
  const expected = await index.query(query()); await index.rebuild(); assert.deepEqual(await index.query(query()), expected);
  await index.deleteSession('codex', 'same'); assert.deepEqual(ids(await index.query(query())), ['claude:same']);
  await index.refresh('codex'); assert.equal((await index.query(query())).length, 2);
  f.rows.delete('claude/same'); await index.refresh('claude'); assert.deepEqual(ids(await index.query(query())), ['codex:same']);
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
    for (const file of await readdir(f.directory)) assert.equal((await stat(join(f.directory, file))).mode & 0o077, 0);
  }
  const sentinel = join(f.root, 'project', 'native'); await writeFile(sentinel, 'untouched');
  await index.purge(); await assert.rejects(stat(f.directory), { code: 'ENOENT' });
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched'); await assert.rejects(index.query(query()), /closed/);
});

test('unsafe cache paths and duplicated providers fail without touching external files', async (t) => {
  const f = await fixture(t);
  const external = join(f.root, 'external'); await mkdir(external); await writeFile(join(external, 'sentinel'), 'safe');
  const link = join(f.root, 'cache-link'); await symlink(external, link);
  await assert.rejects(SearchIndex.open({ directory: link, sources: f.sources }), /private|symbolic|directory/);
  await assert.rejects(SearchIndex.open({ directory: external, sources: f.sources }), /private|owned|empty/);
  assert.equal(await readFile(join(external, 'sentinel'), 'utf8'), 'safe');
  await assert.rejects(SearchIndex.open({ directory: join(f.root, 'duplicate'), sources: [f.sources[0], f.sources[0]] }), /provider/);
  await f.index.close();
  await rm(join(f.directory, 'index.sqlite')); await symlink(join(external, 'sentinel'), join(f.directory, 'index.sqlite'));
  await assert.rejects(SearchIndex.open({ directory: f.directory, sources: f.sources }), /private|regular|symbolic/);
  assert.equal(await readFile(join(external, 'sentinel'), 'utf8'), 'safe');
});

test('F3: cross-handle refresh, deletion, rebuilt source cleanup, and purge invalidate old snapshots', async (t) => {
  const f = await fixture(t); f.add('codex', 'same'); f.add('claude', 'same'); await f.index.refresh();
  const observer = await SearchIndex.open({ directory: f.directory, sources: f.sources }); t.after(() => observer.close());
  f.add('codex', 'same', 'project', 'external change'); await f.index.refresh('codex');
  assert.deepEqual(ids(await observer.query(query('external change'))), ['codex:same']);
  await f.index.deleteSession('codex', 'same'); assert.deepEqual(ids(await observer.query(query())), ['claude:same']);
  const changed = await SearchIndex.open({ directory: f.directory, sources: [{ ...f.sources[0], sourceId: 'new-configured-roots' }] }); t.after(() => changed.close());
  await changed.rebuild();
  assert.deepEqual(await observer.query(query()), [], 'full rebuild drops old provider/root namespaces');
  assert.deepEqual(ids(await changed.query(query())), ['codex:same']);
  await changed.purge();
  await assert.rejects(observer.query(query()), /removed or replaced/);
  await assert.rejects(f.index.refresh(), /removed or replaced/);
});

test('F3: readers observe committed generations during staged refresh, and discovery/read errors roll back all providers', async (t) => {
  const f = await fixture(t); f.add('codex', 'same'); f.add('claude', 'same'); await f.index.refresh();
  const reader = await SearchIndex.open({ directory: f.directory, sources: f.sources }); t.after(() => reader.close());
  const original = f.sources[0].adapter.readHistory;
  let release; let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  f.sources[0].adapter.readHistory = async (...args) => { entered(); await gate; return original(...args); };
  f.add('codex', 'same', 'project', 'committed later');
  const refreshing = f.index.refresh(); await ready;
  assert.deepEqual(ids(await reader.query(query('sapphire'))), ['claude:same', 'codex:same']);
  release(); await refreshing;
  assert.deepEqual(ids(await reader.query(query('committed later'))), ['codex:same']);
  f.sources[0].adapter.readHistory = original;
  const discover = f.sources[1].adapter.discover; f.sources[1].adapter.discover = async () => { throw Error('discovery rejected'); };
  f.add('codex', 'same', 'project', 'must not commit');
  await assert.rejects(f.index.refresh(), /discovery rejected/);
  assert.deepEqual(ids(await reader.query(query('committed later'))), ['codex:same']);
  f.sources[1].adapter.discover = discover;
  const history = f.sources[1].adapter.readHistory; f.sources[1].adapter.readHistory = async () => { throw Error('second provider read rejected'); };
  await assert.rejects(f.index.rebuild(), /second provider read rejected/);
  assert.deepEqual(ids(await reader.query(query('committed later'))), ['codex:same']);
  f.sources[1].adapter.readHistory = history;
});

test('F3: interrupted SQLite writes recover the last complete generation on reopen', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const f = await fixture(t); f.add('codex', 'same'); await f.index.refresh(); await f.index.close();
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE; DELETE FROM sessions;');
    process.kill(process.pid, 'SIGKILL');
  `, join(f.directory, 'index.sqlite')], { stdio: 'pipe' }));
  const recovered = await SearchIndex.open({ directory: f.directory, sources: f.sources }); t.after(() => recovered.close());
  assert.deepEqual(ids(await recovered.query(query('sapphire'))), ['codex:same']);
  await recovered.refresh(); assert.deepEqual(ids(await recovered.query(query())), ['codex:same']);
});

test('public projection excludes adapter metadata; cancellation and private creation under permissive umask', async (t) => {
  const f = await fixture(t); f.add('codex', 'same');
  f.rows.get('codex/same').messages[0].hiddenReasoning = 'HIDDEN_PRIVATE_SENTINEL';
  const discover = f.sources[0].adapter.discover;
  f.sources[0].adapter.discover = async () => (await discover()).map((row) => ({ ...row, credentials: 'CREDENTIAL_PRIVATE_SENTINEL' }));
  await f.index.refresh();
  const disk = await readFile(join(f.directory, 'index.sqlite'));
  assert.equal(disk.includes('HIDDEN_PRIVATE_SENTINEL'), false); assert.equal(disk.includes('CREDENTIAL_PRIVATE_SENTINEL'), false);
  const aborted = AbortSignal.abort(); await assert.rejects(f.index.query(query(), aborted), { name: 'AbortError' });
  const original = process.umask(0);
  let privateIndex;
  try {
    const directory = join(f.root, 'private-cache'); privateIndex = await SearchIndex.open({ directory, sources: f.sources }); await privateIndex.refresh();
    assert.equal((await stat(directory)).mode & 0o077, 0);
    for (const name of await readdir(directory)) assert.equal((await stat(join(directory, name))).mode & 0o077, 0);
  } finally { process.umask(original); await privateIndex?.close(); }
});

test('F4: timestamp instants then session/provider/native identity provide a stable total order after reopen/rebuild', async (t) => {
  const f = await fixture(t);
  f.add('codex', 'b', 'project', 'ordered', { id: 'shared', updatedAt: '2026-01-01T01:00:00+01:00' });
  f.add('codex', 'a', 'project', 'ordered', { id: 'shared', updatedAt: '2026-01-01T00:00:00Z' });
  f.add('claude', 'a', 'project', 'ordered', { id: 'shared', updatedAt: '2026-01-01T00:00:00.000Z' });
  f.add('claude', 'new', 'project', 'ordered', { updatedAt: '2026-01-02T00:00:00Z' });
  await f.index.refresh();
  const identities = (hits) => hits.map((x) => `${x.agent}/${x.nativeId}`);
  const expected = ['claude/new', 'claude/a', 'codex/a', 'codex/b'];
  assert.deepEqual(identities(await f.index.query(query('ordered'))), expected);
  await f.index.rebuild(); assert.deepEqual(identities(await f.index.query(query('ordered'))), expected);
  await f.index.close(); const reopened = await SearchIndex.open({ directory: f.directory, sources: f.sources }); t.after(() => reopened.close());
  assert.deepEqual(identities(await reopened.query(query('ordered'))), expected);
});

test('two writers refresh independent providers without losing committed generations', async (t) => {
  const f = await fixture(t); f.add('codex', 'same'); f.add('claude', 'same'); await f.index.refresh();
  const other = await SearchIndex.open({ directory: f.directory, sources: f.sources }); t.after(() => other.close());
  f.add('codex', 'new', 'project', 'codex new'); f.add('claude', 'new', 'project', 'claude new');
  await Promise.all([f.index.refresh('codex'), other.refresh('claude')]);
  assert.deepEqual(ids(await f.index.query(query())), ['claude:new', 'claude:same', 'codex:new', 'codex:same']);
  assert.deepEqual(await other.query(query()), await f.index.query(query()));
});

test('corrupt changed rows reject repeatedly without leaking content, and an existing handle can rebuild', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const f = await fixture(t); f.add('codex', 'same'); await f.index.refresh();
  const external = new DatabaseSync(join(f.directory, 'index.sqlite'));
  external.prepare('UPDATE sessions SET data=?').run('{"title":"PRIVATE_CORRUPTED_SNIPPET"'); external.close();
  for (let i = 0; i < 2; i++) await assert.rejects(f.index.query(query()), (error) => {
    assert.match(error.message, /Search cache is corrupt/); assert.equal(error.message.includes('PRIVATE_CORRUPTED_SNIPPET'), false); return true;
  });
  await assert.rejects(SearchIndex.open({ directory: f.directory, sources: f.sources }), /Search cache is corrupt/);
  await f.index.rebuild(); assert.deepEqual(ids(await f.index.query(query('sapphire'))), ['codex:same']);
});

const tool = (id, text) => ({ id, role: 'tool', status: 'complete', text });
const said = (id, role, text) => ({ id, role, status: 'complete', text });
const cached = (directory) => {
  const db = new DatabaseSync(join(directory, 'index.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT native_id, data FROM sessions ORDER BY native_id').all().map((row) => ({ nativeId: row.native_id, ...JSON.parse(row.data) })); } finally { db.close(); }
};

test('T1: a tool output item contributes only its first 2 KiB to the index; user and assistant text stay whole', async (t) => {
  const f = await fixture(t);
  const head = `${'h'.repeat(2047)}TOOL_TAIL_NEEDLE`;
  const long = `${'u'.repeat(5000)} USER_TAIL_NEEDLE`;
  f.add('codex', 'tooling', 'project', '', { title: 'Tool heavy', messages: [
    said('u', 'user', long), tool('t', `TOOL_HEAD_NEEDLE ${head}`), said('a', 'assistant', `${'a'.repeat(5000)} ASSISTANT_TAIL_NEEDLE`),
  ] });
  await f.index.refresh();
  const [row] = cached(f.directory);
  const stored = Object.fromEntries(row.messages.map((item) => [item.id, item.text]));
  assert.equal(stored.u, long);
  assert.equal(stored.t, `TOOL_HEAD_NEEDLE ${'h'.repeat(2047)}`.slice(0, 2048));
  assert.equal(stored.a.endsWith('ASSISTANT_TAIL_NEEDLE'), true);
  for (const needle of ['tool heavy', 'tooling', join(f.root, 'project'), 'tool_head_needle', 'user_tail_needle', 'assistant_tail_needle']) {
    assert.deepEqual(ids(await f.index.query(query(needle))), ['codex:tooling'], needle);
  }
  assert.deepEqual(ids(await f.index.query(query('TOOL_TAIL_NEEDLE'))), []);
  // A multi-byte character that straddles the limit is dropped whole, never split.
  f.add('codex', 'tooling', 'project', '', { messages: [tool('t', `${'é'.repeat(1023)}x😀z`)] });
  await f.index.refresh();
  assert.equal(cached(f.directory)[0].messages[0].text, `${'é'.repeat(1023)}x`);
  // A transcript cached by a matching search is bounded the same way.
  const session = { ...f.rows.get('codex/tooling'), messages: [tool('t', `REMEMBERED_HEAD ${'r'.repeat(4000)} REMEMBERED_TAIL`)] };
  await f.index.remember(session);
  assert.equal((await f.index.remembered(session, 'remembered_head'))?.matches[0].field, 'message');
  assert.equal(await f.index.remembered(session, 'remembered_tail'), undefined);
});

test('T2: over the cap, the least recently updated sessions lose their text first and stay listed by title, workspace and ID', async (t) => {
  const f = await fixture(t, { maxBytes: 2500 });
  for (const [nativeId, day] of [['oldest', 1], ['middle', 2], ['newest', 3], ['undated', 0]]) {
    f.add('codex', nativeId, 'project', '', { title: `Title ${nativeId}`, updatedAt: day ? `2026-01-0${day}T00:00:00Z` : '',
      messages: [said('m', 'assistant', `${nativeId.toUpperCase()}_TEXT ${'x'.repeat(1000)}`)] });
  }
  await f.index.refresh();
  // 4 x ~1012 bytes against a 2500-byte cap: the undated and the oldest session are evicted.
  const text = async (needle) => ids(await f.index.query(query(needle)));
  assert.deepEqual(await text('newest_text'), ['codex:newest']);
  assert.deepEqual(await text('middle_text'), ['codex:middle']);
  assert.deepEqual(await text('oldest_text'), []);
  assert.deepEqual(await text('undated_text'), []);
  assert.deepEqual(await text(''), ['codex:newest', 'codex:middle', 'codex:oldest', 'codex:undated']);
  assert.deepEqual(await text('title oldest'), ['codex:oldest']);
  assert.deepEqual(await text('undated'), ['codex:undated']);
  assert.deepEqual(await text(join(f.root, 'project')), ['codex:newest', 'codex:middle', 'codex:oldest', 'codex:undated']);
  const rows = cached(f.directory);
  assert.deepEqual(rows.filter((row) => row.messages.length).map((row) => row.nativeId), ['middle', 'newest']);
  assert.deepEqual(rows.find((row) => row.nativeId === 'oldest'), { nativeId: 'oldest', id: 'codex:oldest', agent: 'codex', title: 'Title oldest', workspace: join(f.root, 'project'), updatedAt: '2026-01-01T00:00:00Z', messages: [] });
  // An evicted session that becomes the most recent is indexed again; the next oldest loses its text.
  f.rows.get('codex/oldest').updatedAt = '2026-01-04T00:00:00Z';
  await f.index.refresh();
  assert.deepEqual(await text('oldest_text'), ['codex:oldest']);
  assert.deepEqual(await text('middle_text'), []);
  // A transcript remembered by a matching search is bounded too.
  await f.index.remember({ ...f.rows.get('codex/middle'), updatedAt: '2026-01-05T00:00:00Z' });
  assert.deepEqual(await text('middle_text'), ['codex:middle']);
  assert.deepEqual(await text('newest_text'), []);
  // Reopening with a lower cap evicts at once.
  const lowered = await SearchIndex.open({ directory: f.directory, sources: f.sources, maxBytes: 1100 }); t.after(() => lowered.close());
  assert.deepEqual(ids(await lowered.query(query('middle_text'))), ['codex:middle']);
  assert.deepEqual(ids(await lowered.query(query('oldest_text'))), []);
  await assert.rejects(SearchIndex.open({ directory: f.directory, sources: f.sources, maxBytes: 256 * 2 ** 20 + 1 }), /cache limit/);
  await assert.rejects(SearchIndex.open({ directory: f.directory, sources: f.sources, maxBytes: 0 }), /cache limit/);
});

test('T2: a version 1 cache is discarded on open, not rewritten: it starts empty, frees its space and refills', async (t) => {
  const f = await fixture(t);
  await f.index.close();
  await rm(join(f.directory, 'index.sqlite'));
  const db = new DatabaseSync(join(f.directory, 'index.sqlite'));
  db.exec('CREATE TABLE sessions (source TEXT NOT NULL, native_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(source, native_id)); PRAGMA user_version=1;');
  const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
  const source = JSON.stringify(['codex', 'codex-fixture']);
  for (let day = 1; day <= 9; day++) {
    insert.run(source, `s${day}`, JSON.stringify({ id: `codex:s${day}`, nativeId: `s${day}`, agent: 'codex', title: `Old ${day}`, workspace: join(f.root, 'project'), updatedAt: `2026-01-0${day}T00:00:00Z`,
      messages: [said('u', 'user', `USER_${day} ${'u'.repeat(100000)}`), tool('t', `TOOL_${day} ${'t'.repeat(1000000)}`)] }));
  }
  db.close();
  await chmod(join(f.directory, 'index.sqlite'), 0o600);
  const before = (await stat(join(f.directory, 'index.sqlite'))).size;
  const index = await SearchIndex.open({ directory: f.directory, sources: f.sources });
  t.after(() => index.close());
  assert.ok((await stat(join(f.directory, 'index.sqlite'))).size < before / 100, 'the discarded text is returned to the file system');
  assert.deepEqual(cached(f.directory), []);
  assert.deepEqual(await index.query(query()), []);
  const check = new DatabaseSync(join(f.directory, 'index.sqlite'), { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 2); check.close();
  f.add('codex', 'fresh'); await index.refresh();
  assert.deepEqual(ids(await index.query(query('sapphire'))), ['codex:fresh']);
});

test('T3: pruning drops cached sessions that left a provider while other providers stay', async (t) => {
  const f = await fixture(t);
  f.add('codex', 'kept'); f.add('codex', 'gone'); f.add('claude', 'gone');
  await f.index.refresh();
  await f.index.prune('codex', ['kept']);
  assert.deepEqual(ids(await f.index.query(query())), ['claude:gone', 'codex:kept']);
  await assert.rejects(f.index.prune('grok', []), /not configured/);
});

// Commits by the index show up as a changed data_version on another connection; rowids show which rows were rewritten.
function observe(directory) {
  const db = new DatabaseSync(join(directory, 'index.sqlite'), { readOnly: true });
  return {
    version: () => db.prepare('PRAGMA data_version').get().data_version,
    rows: () => Object.fromEntries(db.prepare('SELECT native_id, rowid, bytes FROM sessions').all().map((row) => [row.native_id, [row.rowid, row.bytes]])),
    close: () => db.close(),
  };
}

test('T4: an unchanged refresh or remembered transcript writes nothing; a changed session is rewritten once', async (t) => {
  const f = await fixture(t);
  for (const nativeId of ['a', 'b', 'c']) f.add('codex', nativeId, 'project', `${nativeId}-text`);
  await f.index.refresh();
  const db = observe(f.directory); t.after(db.close);
  const results = async () => [ids(await f.index.query(query('text'))), ids(await f.index.query(query('b-text')))];
  const before = { version: db.version(), rows: db.rows(), results: await results() };
  await f.index.refresh();
  await f.index.remember({ ...f.rows.get('codex/a'), messages: f.rows.get('codex/a').messages });
  assert.deepEqual({ version: db.version(), rows: db.rows(), results: await results() }, before);
  f.rows.get('codex/b').messages = [said('m1', 'assistant', 'b-text changed')];
  await f.index.refresh();
  const changed = db.rows();
  assert.notEqual(db.version(), before.version);
  assert.deepEqual([changed.a, changed.c], [before.rows.a, before.rows.c]);
  assert.notEqual(changed.b[0], before.rows.b[0]);
  assert.deepEqual(ids(await f.index.query(query('b-text changed'))), ['codex:b']);
  const after = db.version();
  await f.index.refresh();
  await f.index.remember(f.rows.get('codex/b'));
  assert.deepEqual([db.version(), db.rows()], [after, changed]);
  await f.index.remember({ ...f.rows.get('codex/c'), messages: [said('m1', 'assistant', 'c-text remembered')] });
  assert.notEqual(db.version(), after);
  assert.deepEqual(ids(await f.index.query(query('c-text remembered'))), ['codex:c']);
});

test('T4: over the cap, an unchanged refresh or a remembered evicted transcript writes nothing and keeps results', async (t) => {
  const f = await fixture(t, { maxBytes: 2500 });
  for (const [nativeId, day] of [['oldest', 1], ['middle', 2], ['newest', 3], ['undated', 0]]) {
    f.add('codex', nativeId, 'project', '', { title: `Title ${nativeId}`, updatedAt: day ? `2026-01-0${day}T00:00:00Z` : '',
      messages: [said('m', 'assistant', `${nativeId.toUpperCase()}_TEXT ${'x'.repeat(1000)}`)] });
  }
  await f.index.refresh();
  const db = observe(f.directory); t.after(db.close);
  const results = async () => Promise.all(['newest_text', 'middle_text', 'oldest_text', 'undated_text', ''].map(async (text) => ids(await f.index.query(query(text)))));
  const before = { version: db.version(), rows: db.rows(), results: await results() };
  assert.deepEqual(before.results.slice(0, 4), [['codex:newest'], ['codex:middle'], [], []]);
  await f.index.refresh();
  await f.index.remember(f.rows.get('codex/oldest'));
  await f.index.remember(f.rows.get('codex/newest'));
  assert.deepEqual({ version: db.version(), rows: db.rows(), results: await results() }, before);
});
