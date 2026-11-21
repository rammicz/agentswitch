/** Offline component benchmark; no native provider files or calls. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { cpus, freemem, platform, release, totalmem, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SearchIndex } from '../dist/search-index.js';

const output = process.argv[2];
if (!output) throw Error('Usage: node benchmark/search-index.mjs /path/to/results.json');
const root = await realpath(await mkdtemp(join(tmpdir(), 'agentswitch-benchmark-')));
let index;
try {
  const workspaces = await Promise.all([0, 1, 2, 3].map(async (n) => { const path = join(root, `workspace-${n}`); await mkdir(path); return path; }));
  const corpus = new Map();
  let calls = { discover: 0, history: 0 };
  function make(n) {
    const agent = n % 2 ? 'claude' : 'codex';
    const nativeId = `session-${String(n).padStart(5, '0')}`;
    return { id: `${agent}:${nativeId}`, nativeId, agent, title: `Bounded title session ${String(n).padStart(5, '0')}`,
      workspace: workspaces[n % 4], updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(n / 2))).toISOString(),
      messages: Array.from({ length: 10 }, (_, i) => ({ id: `item-${i}`, role: i % 2 ? 'assistant' : 'user', status: 'complete',
        text: `Public item ${i} session ${String(n).padStart(5, '0')} ${i === 0 ? 'common-word' : i === 1 && n === 7777 ? 'rare-sapphire' : i === 2 && n % 4 === 2 ? 'folder-specific' : i === 3 ? 'é💎 100% [literal]' : 'ordinary-text'} end.` })), };
  }
  for (let n = 0; n < 10000; n++) { const row = make(n); corpus.set(row.nativeId, row); }
  const metadata = () => ({ sessions: corpus.size, items: [...corpus.values()].reduce((n, x) => n + x.messages.length, 0),
    publicTextBytes: [...corpus.values()].reduce((n, x) => n + x.messages.reduce((sum, m) => sum + Buffer.byteLength(m.text), 0), 0),
    itemCodePointLengths: [...new Set([...corpus.values()].flatMap((s) => s.messages.map((m) => [...m.text].length)))].sort((a, b) => a - b) });
  const dataset = metadata();
  const sources = ['codex', 'claude'].map((agent) => ({ sourceId: `benchmark-${agent}-v1`, adapter: {
    id: agent,
    async discover() { calls.discover++; return [...corpus.values()].filter((row) => row.agent === agent).map(({ messages, ...row }) => ({ ...row, messages: [] })); },
    async readHistory(nativeId) { calls.history++; return corpus.get(nativeId).messages; },
  } }));
  const timings = {};
  async function time(name, operation) { const start = performance.now(); const result = await operation(); timings[name] = performance.now() - start; return result; }
  const directory = join(root, 'cache');
  await time('coldOpenDiscoverHydrateCommitMs', async () => { index = await SearchIndex.open({ directory, sources }); await index.refresh(); });
  await index.close();
  await time('reopenAndFirstCompleteQueryMs', async () => { index = await SearchIndex.open({ directory, sources }); assert.equal((await index.query({ text: '', agent: 'all', scope: 'global', workspace: workspaces[0] })).length, 10000); });
  await time('unchangedRefreshMs', () => index.refresh());
  const base = { agent: 'all', scope: 'global', workspace: workspaces[0] };
  const cases = [
    ['browse-all', { ...base, text: '' }],
    ['common-all', { ...base, text: 'common-word' }],
    ['rare-all', { ...base, text: 'rare-sapphire' }],
    ['absent-all', { ...base, text: 'absent-sentinel' }],
    ['title-codex', { ...base, text: 'Bounded title', agent: 'codex' }],
    ['folder-codex', { ...base, text: 'folder-specific', scope: 'folder', workspace: workspaces[2], agent: 'codex' }],
    ['unicode-claude', { ...base, text: 'é💎', agent: 'claude' }],
    ['punctuation-all', { ...base, text: '100% [literal]' }],
  ];
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  function expected(query) {
    const needle = query.text.trim().toLowerCase();
    return [...corpus.values()].filter((s) => (query.agent === 'all' || query.agent === s.agent) && (query.scope === 'global' || s.workspace === query.workspace))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || compare(a.id, b.id) || compare(a.agent, b.agent) || compare(a.nativeId, b.nativeId))
      .flatMap((s) => {
        const matches = [];
        if (needle) {
          if (s.title.toLowerCase().includes(needle)) matches.push({ field: 'title', text: s.title });
          if (s.workspace.toLowerCase().includes(needle)) matches.push({ field: 'workspace', text: s.workspace });
          for (const m of s.messages) if (matches.length < 3 && m.text.toLowerCase().includes(needle)) matches.push({ field: 'message', itemId: m.id, role: m.role, text: m.text });
          if (!matches.length) return [];
        }
        const { messages, ...metadata } = s;
        return [{ ...metadata, matches }];
      });
  }
  const results = cases.map(([name, query]) => ({ name, query, expected: expected(query), samplesMs: [] }));
  for (const entry of results) assert.deepEqual(await index.query(entry.query), entry.expected);
  const warmCalls = { ...calls };
  for (let iteration = 0; iteration < 100; iteration++) {
    for (const entry of results) {
      const start = performance.now(); const hits = await index.query(entry.query); entry.samplesMs.push(performance.now() - start);
      assert.deepEqual(hits, entry.expected); // Full output, IDs/order/excerpts/provenance; outside timing.
    }
  }
  assert.deepEqual(calls, warmCalls, 'warm queries must not discover or hydrate');
  for (let n = 0; n < 100; n++) { const row = make(n); row.title = `Changed ${n}`; row.messages[0].text = `changed-${n}`; corpus.set(row.nativeId, row); }
  for (let n = 9990; n < 10000; n++) corpus.delete(make(n).nativeId);
  for (let n = 10000; n < 10010; n++) { const row = make(n); corpus.set(row.nativeId, row); }
  await time('changed100Removed10Added10RefreshMs', () => index.refresh());
  assert.deepEqual(await index.query({ ...base, text: '' }), expected({ ...base, text: '' }));
  await time('fullRebuildMs', () => index.rebuild());
  assert.deepEqual(await index.query({ ...base, text: '' }), expected({ ...base, text: '' }));
  const report = {
    runner: process.env.BENCHMARK_RUNNER ?? 'local-linux-development', command: 'npm run build && node benchmark/search-index.mjs <output.json>',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    node: process.version, platform: platform(), release: release(), architecture: process.arch, cpu: cpus()[0]?.model,
    logicalCpus: cpus().length, memoryBytes: totalmem(), freeMemoryBytesAtEnd: freemem(),
    dataset: { generator: 'deterministic sequential v1 (no random seed)', ...dataset, workspaces: 4, providers: 2, shortItemsPerSession: 10 },
    method: { warmupsPerCase: 1, samplesPerCase: 100, sequence: 'fixed mixed cases each iteration', budgetMs: 200, statistic: 'maximum',
      timed: 'complete query service call including every hit and bounded excerpt; no result memoization', validation: 'full exact output against independent fixture oracle after every timed call',
      cache: 'SQLite DELETE journal plus restored in-process literal scan', normalization: 'trim query; Unicode default lowercase; no accent folding', excerpts: '3 per hit, 240 code points plus ellipses',
      concurrency: 'one benchmark process, shared development runner', boundary: 'fake adapter component ingestion; native reader ingestion performance not measured' },
    phasesMs: timings, adapterCalls: calls,
    cases: results.map(({ name, samplesMs, expected }) => {
      const sorted = [...samplesMs].sort((a, b) => a - b);
      return { name, count: expected.length, minMs: sorted[0], medianMs: sorted[49], p95Ms: sorted[94], maxMs: sorted.at(-1), samplesMs };
    }),
  };
  report.pass = report.cases.every((entry) => entry.maxMs <= 200);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ pass: report.pass, phasesMs: timings, cases: report.cases.map(({ samplesMs, ...summary }) => summary) }, null, 2));
  assert.equal(report.pass, true, 'every complete warm query must take <=200ms');
} finally { await index?.close(); await rm(root, { recursive: true, force: true }); }
