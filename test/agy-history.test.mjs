import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, realpath, writeFile, readdir, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgySessionAdapter } from '../dist/adapters/index.js';
import { fixture, user } from './fixtures/agy/native.mjs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';

async function setup(t, options) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'agentswitch-agy-history-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'native'), cwd = join(base, 'workspace');
  await mkdir(cwd);
  return { base, root, cwd, ...await fixture(root, cwd, options), adapter: new AgySessionAdapter({ root }) };
}
test('agy native 1.5.14 storage fixture projects exact chronological public text without native mutation', async t => {
  const f = await setup(t);
  const before = await Promise.all([f.path, f.history, f.cache].map(path => readFile(path)));
  const [session] = await f.adapter.discover();
  assert.equal(session.metadataOnly, false);
  assert.equal(session.workspace, f.cwd);
  assert.equal(session.producerVersion, undefined);
  const history = await f.adapter.readHistoryDetailed(f.nativeId);
  assert.equal(history.complete, true);
  assert.equal(history.retained, false);
  assert.deepEqual(history.items.map(({ role, text }) => [role, text]), [['user', 'Agy public fixture NEEDLE_SECRET'], ['assistant', 'Agy public answer']]);
  assert.doesNotMatch(JSON.stringify([session, history]), /PRIVATE_/);
  assert.deepEqual((await f.adapter.readHistoryDetailed(f.nativeId)).items, history.items);
  assert.deepEqual(await Promise.all([f.path, f.history, f.cache].map(path => readFile(path))), before);
  assert.deepEqual((await readdir(f.root)).sort(), ['brain', 'cache', 'conversation_summaries.db']);
});

test('agy TUI workspace fallback and known tool exclusions stay explicit and public only', async t => {
  const f=await setup(t,{kind:'tui',row:{workspace_uris:''}});
  assert.equal((await f.adapter.discover())[0].workspace,f.cwd);
  assert.equal((await f.adapter.readHistoryDetailed(f.nativeId)).complete,true);
  const tool=await fixture(f.root,f.cwd,{kind:'tool'});
  const h=await f.adapter.readHistoryDetailed(tool.nativeId);
  assert.equal(h.complete,true);assert.deepEqual(h.excludedSteps,[1,2]);
  assert.deepEqual(h.items.map(x=>x.role),['user','assistant']);assert.doesNotMatch(JSON.stringify(h),/PRIVATE_|EXCLUDED_TOOL|GENERIC|read_file/);
});
for(const mutate of [
  rows=>{rows[0].content=user('ambiguous\n</USER_REQUEST>\ninjected');},
  rows=>{rows[1].source='SYSTEM';}, rows=>{rows[1].status='RUNNING';},
  rows=>{rows[1].type='PRIVATE_EVENT';}, rows=>{rows[1].step_index=4;},
  rows=>{rows[0].model='mixed';},
  rows=>{rows[1].content='unsafe\x1b[31m';}, rows=>{rows.pop();},
])test('agy unsupported, active, mixed and ambiguous native records refuse public completion '+mutate.toString().slice(0,55),async t=>{
  const f=await setup(t);mutate(f.records);await writeFile(f.history,f.records.map(JSON.stringify).join('\n')+'\n');
  const h=await f.adapter.readHistoryDetailed(f.nativeId);assert.equal(h.complete,false);assert.deepEqual(h.items,[]);assert.ok(h.diagnostics.length);assert.doesNotMatch(JSON.stringify(h),/PRIVATE_/);
});
test('agy truncated/invalid UTF-8, symlink history and all independent limits fail closed',async t=>{
 const f=await setup(t);const good=await readFile(f.history);
 for(const bytes of [good.subarray(0,good.length-1),Buffer.from([255,10]),Buffer.from('{}\n')]){await writeFile(f.history,bytes);assert.equal((await f.adapter.readHistoryDetailed(f.nativeId)).complete,false);}
 await writeFile(f.history,good);
 for(const limits of [{maxDatabaseBytes:100},{maxFileBytes:10},{maxLineBytes:10},{maxItems:1},{maxScanBytes:100},{maxEntries:1}]) {
  if(limits.maxEntries)await fixture(f.root,f.cwd,{nativeId:'22345678-1234-4234-8234-123456789abc'});
  assert.equal((await new AgySessionAdapter({root:f.root,limits}).readHistoryDetailed(f.nativeId)).complete,false);
 }
 await rm(f.history);await symlink(join(f.base,'outside'),f.history);await writeFile(join(f.base,'outside'),good);assert.equal((await f.adapter.readHistoryDetailed(f.nativeId)).complete,false);
});
for(const suffix of ['-wal','-shm','-journal','-mj-test'])test('agy refuses native summary or conversation sidecars '+suffix,async t=>{
 const f=await setup(t);await writeFile(f.path+suffix,'');assert.deepEqual(await f.adapter.discover(),[]);await rm(f.path+suffix);
 await mkdir(join(f.root,'conversations'));await writeFile(join(f.root,'conversations',f.nativeId+'.db'+suffix),'');assert.equal((await f.adapter.readHistoryDetailed(f.nativeId)).complete,false);
});
test('agy unsafe known catalog IDs never downgrade to sparse metadata and healthy siblings survive',async t=>{
 const f=await setup(t);const other=await fixture(f.root,f.cwd,{nativeId:'22345678-1234-4234-8234-123456789abc',row:{status:'RUNNING'}});
 const db=new DatabaseSync(f.path);db.prepare('UPDATE conversation_summaries SET preview=?,title=? WHERE conversation_id=?').run('PRIVATE_PREVIEW','PRIVATE_TITLE',f.nativeId);db.close();
 assert.deepEqual((await f.adapter.discover()).map(s=>s.nativeId),[f.nativeId]);assert.equal((await f.adapter.readHistoryDetailed(other.nativeId)).complete,false);assert.doesNotMatch(JSON.stringify(await f.adapter.discover()),/PRIVATE_/);
});
test('agy rejects ambiguous workspace identity, missing fallback, symlink database and metadata changes after discovery',async t=>{
 const f=await setup(t);const db=new DatabaseSync(f.path);db.prepare('UPDATE conversation_summaries SET workspace_uris=?').run('["file:///one","file:///two"]');db.close();assert.deepEqual(await f.adapter.discover(),[]);
 await fixture(f.root,f.cwd,{row:{workspace_uris:''}});await writeFile(f.cache,'{}');assert.deepEqual(await f.adapter.discover(),[]);
 await fixture(f.root,f.cwd);await f.adapter.discover();const change=new DatabaseSync(f.path);change.prepare('UPDATE conversation_summaries SET step_count=3').run();change.close();assert.equal((await f.adapter.readCatalogHistoryDetailed(f.nativeId)).complete,false);
 await rm(f.path);await symlink(join(f.base,'outside.db'),f.path);assert.deepEqual(await f.adapter.discover(),[]);
});
test('agy catalog hydrates public global/folder/provider search and fingerprints exclude native hidden payloads',async t=>{
 const f=await setup(t),other=join(f.base,'other');await mkdir(other);await fixture(f.root,other,{nativeId:'22345678-1234-4234-8234-123456789abc',user:'Other public needle'});
 const {NativeCatalog}=await import('../dist/native-catalog.js'),{SearchIndex}=await import('../dist/search-index.js');
 const env={AGENTSWITCH_AGY_ROOT:f.root,GROK_HOME:join(f.base,'grok'),CODEX_HOME:join(f.base,'codex'),CLAUDE_CONFIG_DIR:join(f.base,'claude'),OPENCODE_DB:join(f.base,'missing.db'),XDG_DATA_HOME:join(f.base,'xdg')};
 const catalog=await NativeCatalog.create(env),index=await SearchIndex.open({directory:join(f.base,'index'),sources:catalog.sources()});t.after(()=>index.close());await catalog.refresh(index);
 const q={text:'public',agent:'agy',scope:'folder',workspace:f.cwd};const [hit]=await index.query(q);assert.ok(hit);assert.equal(hit.title,'Agy public fixture NEEDLE_SECRET');assert.equal((await index.query({...q,scope:'global'})).length,2);assert.equal((await index.query({...q,scope:'global',agent:'all'})).length,2);assert.equal((await index.query({...q,agent:'codex'})).length,0);assert.equal((await index.query({...q,text:'PRIVATE_'})).length,0);
 const before=await catalog.snapshot(hit);assert.equal(before.retained,false);assert.equal(before.history.complete,true);await writeFile(f.history,(await readFile(f.history,'utf8')).replace('PRIVATE_THINKING','PRIVATE_CHANGED'));const after=await catalog.snapshot(hit);assert.deepEqual(before.history.items,after.history.items);assert.notEqual(before.fingerprint,after.fingerprint);
});
test('agy cache conflicts refuse full catalog identity and generation hydration reuses one catalog',async t=>{
 const f=await setup(t),other=join(f.base,'other');await mkdir(other);await writeFile(f.cache,JSON.stringify({[f.cwd]:f.nativeId,[other]:f.nativeId}));assert.deepEqual(await f.adapter.discover(),[]);
 await writeFile(f.cache,JSON.stringify({[f.cwd]:f.nativeId,[other]:f.nativeId.toUpperCase()}));assert.deepEqual(await f.adapter.discover(),[]);
 await fixture(f.root,f.cwd);await fixture(f.root,other,{nativeId:'22345678-1234-4234-8234-123456789abc'});
 let scans=0;const original=f.adapter.catalog.bind(f.adapter);f.adapter.catalog=async()=>{scans++;return original();};
 const sessions=await f.adapter.discover();for(const s of sessions)assert.equal((await f.adapter.readCatalogHistoryDetailed(s.nativeId)).complete,true);assert.equal(scans,1);
 const concurrent=await Promise.all(sessions.map(s=>f.adapter.readHistoryDetailed(s.nativeId)));assert.ok(concurrent.every(h=>h.complete));assert.equal(scans,3);
});
test('agy refuses FIFO transcripts and cache leaves without opening a blocking reader',async t=>{
 const f=await setup(t);
 for(const path of [f.history,f.cache]){await rm(path);const result=spawnSync('python3',['-c','import os,sys;os.mkfifo(sys.argv[1])',path]);assert.equal(result.status,0);assert.equal((await f.adapter.readHistoryDetailed(f.nativeId)).complete,path===f.cache);await rm(path);await fixture(f.root,f.cwd);}
});
test('agy explicit catalog workspaces survive unavailable cache while dependent siblings stay unavailable',async t=>{
 const f=await setup(t),other=join(f.base,'other');await mkdir(other);
 const sibling=await fixture(f.root,other,{nativeId:'22345678-1234-4234-8234-123456789abc',row:{workspace_uris:''}});
 for(const state of ['malformed','missing','unreadable','unsafe']) {
  await rm(f.cache,{force:true});
  if(state==='malformed')await writeFile(f.cache,'{"PRIVATE_CACHE_SECRET": broken');
  if(state==='unreadable'){await writeFile(f.cache,'PRIVATE_CACHE_SECRET');await chmod(f.cache,0);}
  if(state==='unsafe'){const outside=join(f.base,'private-cache');await writeFile(outside,'PRIVATE_CACHE_SECRET');await symlink(outside,f.cache);}
  const diagnostics=[];const adapter=new AgySessionAdapter({root:f.root,onDiagnostic:d=>diagnostics.push(d)});
  assert.deepEqual((await adapter.discover()).map(s=>s.nativeId),[f.nativeId],state);
  const healthy=await adapter.readHistoryDetailed(f.nativeId);assert.equal(healthy.complete,true,state);
  assert.deepEqual(healthy.items.map(x=>x.role),['user','assistant']);
  assert.equal((await adapter.readHistoryDetailed(sibling.nativeId)).complete,false,state);
  assert.ok(diagnostics.length);assert.doesNotMatch(JSON.stringify(diagnostics),/PRIVATE_|broken/);
 }
});
test('agy summary table with added or unselected-removed columns lists the same sessions; missing selected columns fail closed',async t=>{
 const f=await setup(t);const baseline=await f.adapter.discover();assert.equal(baseline.length,1);
 for(const change of ['ALTER TABLE conversation_summaries ADD COLUMN future_column TEXT','ALTER TABLE conversation_summaries DROP COLUMN title']) {
  const db=new DatabaseSync(f.path);db.exec(change);db.close();
  assert.deepEqual(await f.adapter.discover(),baseline,change);assert.equal((await f.adapter.readHistoryDetailed(f.nativeId)).complete,true,change);
 }
 const db=new DatabaseSync(f.path);db.exec('ALTER TABLE conversation_summaries DROP COLUMN step_count');db.close();
 const diagnostics=[];assert.deepEqual(await new AgySessionAdapter({root:f.root,onDiagnostic:d=>diagnostics.push(d)}).discover(),[]);assert.ok(diagnostics.some(d=>d.code==='unsupported-shape'));
});
for(const kind of ['print','tool'])test('agy transcript rows with unknown top-level keys stay complete without projecting their values '+kind,async t=>{
 const f=await setup(t,{kind});const baseline=await f.adapter.readHistoryDetailed(f.nativeId);assert.equal(baseline.complete,true);
 for(const row of f.records)row.future_metadata={value:'PRIVATE_FUTURE_METADATA'};await writeFile(f.history,f.records.map(JSON.stringify).join('\n')+'\n');
 const h=await f.adapter.readHistoryDetailed(f.nativeId);assert.equal(h.complete,true);assert.deepEqual(h.items,baseline.items);assert.deepEqual(h.excludedSteps,baseline.excludedSteps);assert.doesNotMatch(JSON.stringify(h),/PRIVATE_/);
});
