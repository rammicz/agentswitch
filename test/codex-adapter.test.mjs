import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile, appendFile, symlink, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { CodexSessionAdapter } from '../dist/adapters/codex.js';
import { ids, stamp, line, completed, rollout, encode, writeRollout, schema, row } from './fixtures/codex/native.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(),'agentswitch-codex-')));
  t.after(() => rm(root,{recursive:true,force:true}));
  const cwd = join(root,'workspace'); await mkdir(cwd);
  return {root,cwd};
}
async function tree(root) {
  const found = {};
  async function walk(path,rel = '') {
    for (const entry of await readdir(path,{withFileTypes:true})) {
      const sub = join(path,entry.name), key = join(rel,entry.name);
      if (entry.isDirectory()) {found[key] = 'directory'; await walk(sub,key);}
      else if (!entry.isSymbolicLink()) found[key] = (await readFile(sub)).toString('base64');
    }
  }
  await walk(root); return found;
}

test('current paginated public projection and SQLite-selected native metadata are read without source writes', async t => {
  const {root,cwd} = await fixture(t);
  const records = rollout(cwd,ids[0],[completed('UserMessage','u','Public sentinel',1),completed('AgentMessage','a','Answer',2),completed('CommandExecution','tool','Failed output',3,{status:'failed',command:['PRIVATE_COMMAND']}),completed('Reasoning','secret','PRIVATE_REASONING',4)],{base_instructions:{text:'PRIVATE_INSTRUCTIONS'}});
  const path = await writeRollout(root,records);
  const db = new DatabaseSync(join(root,'state_5.sqlite')); schema(db); row(db,ids[0],path,cwd); db.close();
  const before = await tree(root), diagnostics = [];
  const adapter = new CodexSessionAdapter({root,onDiagnostic:d=>diagnostics.push(d)});
  const sessions = await adapter.discover();
  assert.equal(sessions.length,1);
  assert.equal(sessions[0].nativeId,ids[0]); assert.equal(sessions[0].title,'Named session');
  assert.equal(sessions[0].workspace,cwd); assert.equal(sessions[0].createdAt,'2026-11-20T10:00:00.000Z');
  assert.deepEqual(sessions[0].messages,[]);
  const history = await adapter.readHistoryDetailed(ids[0]);
  assert.equal(history.complete,true);
  assert.equal(history.retained,true);assert.deepEqual(history.itemTurns.map(({threadId,turnId})=>({threadId,turnId})),Array.from({length:3},()=>({threadId:ids[0],turnId:'turn-1'})));
  assert.deepEqual(history.items.map(({role,text,status})=>({role,text,status})),[{role:'user',text:'Public sentinel',status:'complete'},{role:'assistant',text:'Answer',status:'complete'},{role:'tool',text:'Failed output',status:'failed'}]);
  assert.deepEqual(history.items,await adapter.readHistory(ids[0]));
  assert.doesNotMatch(JSON.stringify({sessions,history,diagnostics}),/PRIVATE_/);
  assert.deepEqual(await tree(root),before);
});
test('paginated compaction cannot certify retained public context or native growth',async t=>{
 const {root,cwd}=await fixture(t);
 await writeRollout(root,rollout(cwd,ids[0],[completed('UserMessage','u','Public',1),completed('AgentMessage','a','Answer',2),completed('ContextCompaction','compact','PRIVATE_COMPACTION',3)]));
 const history=await new CodexSessionAdapter({root}).readHistoryDetailed(ids[0]);assert.equal(history.complete,true);assert.equal(history.retained,false);assert.equal(history.itemTurns.length,2);assert.doesNotMatch(JSON.stringify(history),/PRIVATE_COMPACTION/);
});

async function metadata(root, entries) {
  const db = new DatabaseSync(join(root,'state_5.sqlite')); schema(db);
  for (const [id,path,cwd,name] of entries) row(db,id,path,cwd,name);
  db.close();
}
const texts = result => result.items.map(item=>item.text);

test('fork identity survives shared root IDs and selected revert excludes obsolete sibling history', async t => {
  const {root,cwd} = await fixture(t);
  const original = await writeRollout(root,rollout(cwd,ids[0],[completed('UserMessage','old','OBSOLETE',1)]));
  const selected = await writeRollout(root,rollout(cwd,ids[0],[completed('UserMessage','kept','Kept',1)]),{rolloutId:ids[4],date:'2026-11-19T10-00-00'});
  const fork = await writeRollout(root,rollout(cwd,ids[1],[completed('UserMessage','fork','Fork',1)],{session_id:ids[0]}));
  await metadata(root,[[ids[0],selected,cwd,'Same title'],[ids[1],fork,cwd,'Same title']]);
  const adapter = new CodexSessionAdapter({root});
  assert.deepEqual((await adapter.discover()).map(s=>s.nativeId),[ids[0],ids[1]]);
  assert.deepEqual(texts(await adapter.readHistoryDetailed(ids[0])),['Kept']);
  assert.deepEqual(texts(await adapter.readHistoryDetailed(ids[1])),['Fork']);
  const db = new DatabaseSync(join(root,'state_5.sqlite'));
  db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(join(root,'missing.jsonl'),ids[0]); db.close();
  assert.deepEqual((await adapter.discover()).map(s=>s.nativeId),[ids[1]]);
  assert.notEqual(original,selected);
});

test('aliased roots retain the selected rollout, compressed counterpart and managed-file containment', async t => {
  const {root,cwd} = await fixture(t);
  const alias = join(root,'native-alias'); await symlink(root,alias);
  await writeRollout(root,rollout(cwd,ids[0],[completed('UserMessage','old','OBSOLETE',1)]));
  const selected = await writeRollout(root,rollout(cwd,ids[0],[completed('UserMessage','kept','Kept',1)]),{rolloutId:ids[4]});
  const aliasedSelection = join(alias,relative(root,selected));
  await metadata(root,[[ids[0],aliasedSelection,cwd,'Selected through alias']]);
  const diagnostics = [], adapter = new CodexSessionAdapter({root:alias,onDiagnostic:d=>diagnostics.push(d)});
  assert.deepEqual((await adapter.discover()).map(s=>s.nativeId),[ids[0]]);
  assert.deepEqual(texts(await adapter.readHistoryDetailed(ids[0])),['Kept']);
  await writeFile(`${selected}.zst`,zstdCompressSync(await readFile(selected))); await rm(selected);
  assert.deepEqual(texts(await adapter.readHistoryDetailed(ids[0])),['Kept']);

  const db = new DatabaseSync(join(root,'state_5.sqlite')); t.after(()=>db.close());
  const select = path => db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(path,ids[0]);
  select(join(alias,'sessions','missing.jsonl'));
  assert.deepEqual(await adapter.discover(),[]);
  const outside = await fixture(t);
  const external = await writeRollout(outside.root,rollout(outside.cwd,ids[0],[]),{rolloutId:ids[4]});
  select(external);
  assert.deepEqual(await adapter.discover(),[]);
  const linkedFile = join(root,'sessions','selected-link.jsonl');
  await symlink(`${selected}.zst`,linkedFile); select(linkedFile);
  assert.deepEqual(await adapter.discover(),[]);
  assert.ok(diagnostics.some(d=>d.code==='selected-rollout-unavailable'));
});

test('legacy mirrored messages emit once; structured output excludes nontext and private context', async t => {
  const {root,cwd} = await fixture(t);
  const records = rollout(cwd,ids[0],[
    line('event_msg',{type:'user_message',message:'Question'}),
    line('response_item',{type:'message',id:'u',role:'user',content:[{type:'input_text',text:'Question'},{type:'input_image',text:'PRIVATE_IMAGE'}]}),
    line('response_item',{type:'message',id:'sys',role:'developer',content:[{type:'input_text',text:'PRIVATE_SYSTEM'}]}),
    line('response_item',{type:'reasoning',summary:[{type:'summary_text',text:'PRIVATE_SUMMARY'}],content:[{type:'reasoning_text',text:'PRIVATE_REASON'}],encrypted_content:'PRIVATE_ENCRYPTED'}),
    line('turn_context',{base_instructions:'PRIVATE_CONTEXT'}),
    line('credentials',{token:'PRIVATE_CREDENTIAL'}),
    line('response_item',{type:'message',id:'a',role:'assistant',content:[{type:'output_text',text:'Answer'}]}),
    line('event_msg',{type:'agent_message',message:'Answer'}),
    line('response_item',{type:'function_call_output',call_id:'tool',output:[{type:'input_text',text:'Tool text'},{type:'input_image',image_url:'PRIVATE_BINARY'}]}),
    line('response_item',{type:'custom_tool_call_output',call_id:'tool2',output:'String output'}),
    line('event_msg',{type:'agent_message',message:'Event only'}),
  ],{history_mode:'legacy'});
  delete records[0].payload.history_mode; delete records[0].ordinal;
  await writeRollout(root,records);
  await writeFile(join(root,'session_index.jsonl'),`${JSON.stringify({id:ids[0],thread_name:'Old name',updated_at:stamp})}\n${JSON.stringify({id:ids[0],thread_name:'Final name',updated_at:stamp})}\n`);
  const adapter = new CodexSessionAdapter({root});
  assert.equal((await adapter.discover())[0].title,'Final name');
  const result = await adapter.readHistoryDetailed(ids[0]);
  assert.deepEqual(texts(result),['Question','Answer','Tool text','String output','Event only']);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);
});

test('exact fork cutoffs survive parent appends and nested empty archived/compressed intermediates', async t => {
  const {root,cwd} = await fixture(t);
  const parentRecords = rollout(cwd,ids[0],[completed('UserMessage','p','Inherited',1),completed('AgentMessage','later','Not inherited',2)]);
  const parentPath = await writeRollout(root,parentRecords,{archive:true});
  const prefix = encode(parentRecords.slice(0,2));
  const base = {thread_id:ids[0],end_ordinal_exclusive:2,end_byte_offset:prefix.length};
  const middleRecords = rollout(cwd,ids[1],[],{history_base:base});
  const middlePath = await writeRollout(root,middleRecords,{archive:true});
  await writeFile(`${middlePath}.zst`,zstdCompressSync(encode(middleRecords))); await rm(middlePath);
  const childBase = {thread_id:ids[1],end_ordinal_exclusive:3,end_byte_offset:encode(middleRecords).length};
  await writeRollout(root,rollout(cwd,ids[2],[completed('AgentMessage','c','Child answer',4)],{history_base:childBase}));
  const adapter = new CodexSessionAdapter({root});
  const before = await adapter.readHistoryDetailed(ids[2]);
  assert.equal(before.complete,true); assert.deepEqual(texts(before),['Inherited','Child answer']);
  await appendFile(parentPath,encode([completed('AgentMessage','appended','LATER APPEND',3)]));
  assert.deepEqual(await adapter.readHistoryDetailed(ids[2]),before);
});

test('subagent display boundary omits inherited model context', async t => {
  const {root,cwd} = await fixture(t);
  const parent = rollout(cwd,ids[0],[completed('UserMessage','p','PARENT CONTEXT',1)]);
  await writeRollout(root,parent);
  await writeRollout(root,rollout(cwd,ids[1],[completed('UserMessage','c','Child public',3)],{history_base:{thread_id:ids[0],end_ordinal_exclusive:2,end_byte_offset:encode(parent).length},attached_thread:true,forked_from_ordinal_exclusive:2,subagent_history_start_ordinal:3}));
  const result = await new CodexSessionAdapter({root}).readHistoryDetailed(ids[1]);
  assert.equal(result.complete,true); assert.deepEqual(texts(result),['Child public']);
});

for (const invalid of ['missing','cycle','owner','midpoint','oversize','ordinal','escape']) {
  test(`invalid ancestry ${invalid} keeps child and emits bounded safe incomplete diagnostics`, async t => {
    const {root,cwd} = await fixture(t);
    const parent = rollout(cwd,ids[0],[completed('UserMessage','p','Parent',1)]);
    const parentPath = await writeRollout(root,parent);
    let base = {thread_id:ids[0],end_ordinal_exclusive:2,end_byte_offset:encode(parent).length};
    if (invalid === 'missing') base.thread_id = ids[9];
    if (invalid === 'cycle') base.thread_id = ids[1];
    if (invalid === 'midpoint') base.end_byte_offset--;
    if (invalid === 'oversize') base.end_byte_offset += 100;
    if (invalid === 'ordinal') base.end_ordinal_exclusive++;
    if (invalid === 'owner') {parent[0].payload.id = ids[8]; await writeFile(parentPath,encode(parent));}
    if (invalid === 'escape') {const outside = await mkdtemp(join(tmpdir(),'agentswitch-external-')); t.after(()=>rm(outside,{recursive:true,force:true})); const target = join(outside,'external.jsonl'); await writeFile(target,encode(parent)); await rm(parentPath); await symlink(target,parentPath);}
    await writeRollout(root,rollout(cwd,ids[1],[completed('AgentMessage','c','Child',base.end_ordinal_exclusive + 1)],{history_base:base}));
    const result = await new CodexSessionAdapter({root,limits:{maxDiagnostics:5}}).readHistoryDetailed(ids[1]);
    assert.equal(result.complete,false); assert.deepEqual(texts(result),['Child']);
    assert.ok(result.diagnostics.length > 0 && result.diagnostics.length <= 5);
    assert.doesNotMatch(JSON.stringify(result.diagnostics),/Parent|Child|external\.jsonl/);
  });
}

test('malformed interior, partial UTF8 and unknown modes preserve healthy siblings; completing append yields one stable item', async t => {
  const {root,cwd} = await fixture(t);
  const diagnostics = [];
  const path = await writeRollout(root,rollout(cwd,ids[0],[completed('UserMessage','u','Public',1)]));
  const partial = encode([completed('AgentMessage','a','Appended č',3)]);
  await appendFile(path,Buffer.concat([Buffer.from('{"PRIVATE_MALFORMED":\n'),partial.subarray(0,partial.indexOf(Buffer.from('č')) + 1)]));
  await writeRollout(root,rollout(cwd,ids[1],[],{history_mode:'future'}));
  await writeRollout(root,rollout(cwd,ids[2],[completed('AgentMessage','healthy','Healthy',1)],{cli_version:'999.0.0'}));
  const adapter = new CodexSessionAdapter({root,onDiagnostic:d=>diagnostics.push(d),limits:{maxDiagnostics:8}});
  assert.deepEqual((await adapter.discover()).map(s=>s.nativeId),[ids[0],ids[2]]);
  const before = await adapter.readHistoryDetailed(ids[0]);
  assert.equal(before.complete,false); assert.deepEqual(texts(before),['Public']);
  assert.ok(diagnostics.some(d=>d.code==='unsupported-mode')); assert.ok(diagnostics.some(d=>d.code==='untested-producer'));
  assert.ok(before.diagnostics.some(d=>d.code==='partial-record'));
  await appendFile(path,partial.subarray(partial.indexOf(Buffer.from('č')) + 1));
  const after = await adapter.readHistoryDetailed(ids[0]);
  assert.deepEqual(texts(after),['Public','Appended č']); assert.equal(after.items[0].id,before.items[0].id);
  assert.deepEqual(after.items,(await adapter.readHistoryDetailed(ids[0])).items);
  assert.doesNotMatch(JSON.stringify(diagnostics),/PRIVATE_|Appended/);
});

test('valid final record without newline is public, incomplete tool statuses are explicit and later abort leaves earlier item complete', async t => {
  const {root,cwd} = await fixture(t);
  const records = rollout(cwd,ids[0],[completed('AgentMessage','a','failed is just prose',1),line('event_msg',{type:'turn_aborted',turn_id:'separate-turn'},2),completed('CommandExecution','d','Declined',3,{status:'declined'}),completed('CommandExecution','i','Running',4,{status:'in_progress'}),completed('McpToolCall','m','',5,{status:'failed',result:{content:[{type:'text',text:'MCP text'},{type:'image',data:'PRIVATE'}]}}),completed('UnknownPrivate','x','PRIVATE_UNKNOWN',6)]);
  const path = await writeRollout(root,records); await writeFile(path,encode(records).subarray(0,-1));
  const result = await new CodexSessionAdapter({root}).readHistoryDetailed(ids[0]);
  assert.deepEqual(result.items.map(i=>[i.text,i.status]),[['failed is just prose','complete'],['Declined','failed'],['Running','interrupted'],['MCP text','failed']]);
  assert.equal(result.complete,false); assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
});

test('compressed histories are equivalent, deduplicated, bounded and never materialized', async t => {
  const {root,cwd} = await fixture(t);
  const records = rollout(cwd,ids[0],[completed('UserMessage','u','A'.repeat(500),1)]);
  const plain = await writeRollout(root,records); await writeFile(`${plain}.zst`,zstdCompressSync(encode(records)));
  const adapter = new CodexSessionAdapter({root});
  assert.equal((await adapter.discover()).length,1);
  const expected = await adapter.readHistory(ids[0]); await rm(plain);
  const before = await tree(root); assert.deepEqual(await adapter.readHistory(ids[0]),expected); assert.deepEqual(await tree(root),before);
  const bad = await writeRollout(root,rollout(cwd,ids[1],[])); await rm(bad); await writeFile(`${bad}.zst`,Buffer.from('PRIVATE_CORRUPT'));
  const diagnostics = [];
  assert.deepEqual((await new CodexSessionAdapter({root,onDiagnostic:d=>diagnostics.push(d)}).discover()).map(s=>s.nativeId),[ids[0]]);
  assert.ok(diagnostics.some(d=>d.code==='compressed-invalid'));
  const capped = [];
  assert.deepEqual(await new CodexSessionAdapter({root,limits:{maxDecodedBytes:100},onDiagnostic:d=>capped.push(d)}).discover(),[]);
  assert.ok(capped.some(d=>d.code==='input-limit')); assert.doesNotMatch(JSON.stringify(diagnostics),/PRIVATE/);
});

test('committed WAL-only selection/name and locked native database are read without changing DB/WAL/shm', async t => {
  const {root,cwd} = await fixture(t);
  const original = await writeRollout(root,rollout(cwd,ids[0],[completed('UserMessage','u','Old',1)]));
  const selected = await writeRollout(root,rollout(cwd,ids[0],[completed('UserMessage','u','Selected',1)]),{rolloutId:ids[5]});
  const db = new DatabaseSync(join(root,'state_5.sqlite')); t.after(()=>db.close());
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0'); schema(db); row(db,ids[0],original,cwd,'Old name');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); row(db,ids[0],selected,cwd,'Only in WAL');
  db.exec('BEGIN IMMEDIATE'); // A native writer holds a reserved lock; committed WAL stays readable.
  const before = await tree(root);
  const adapter = new CodexSessionAdapter({root});
  assert.equal((await adapter.discover())[0].title,'Only in WAL');
  assert.deepEqual(await adapter.readHistory(ids[0]),[{id:`codex:${ids[5]}:u`,role:'user',text:'Selected',status:'complete'}]);
  assert.deepEqual(await tree(root),before); db.exec('ROLLBACK');
});

test('root precedence, relocated metadata, canonical workspace and absent metadata are explicit', async t => {
  const {root,cwd} = await fixture(t);
  const sqliteRoot = join(root,'metadata'); await mkdir(sqliteRoot);
  const link = join(root,'workspace-link'); await symlink(cwd,link);
  const path = await writeRollout(root,rollout(link,ids[0],[]));
  await metadata(sqliteRoot,[[ids[0],path,link,'Relocated']]);
  const env = {CODEX_HOME:join(root,'wrong'),CODEX_SQLITE_HOME:join(root,'wrong')};
  const explicit = new CodexSessionAdapter({root,sqliteRoot,env});
  const session = (await explicit.discover())[0]; assert.equal(session.workspace,cwd); assert.equal(session.title,'Relocated');
  const viaEnv = new CodexSessionAdapter({env:{CODEX_HOME:root,CODEX_SQLITE_HOME:sqliteRoot}});
  assert.equal((await viaEnv.discover())[0].title,'Relocated');
  const defaultHome = join(root,'default'); await mkdir(defaultHome); await symlink(root,join(defaultHome,'.codex'));
  assert.equal((await new CodexSessionAdapter({home:defaultHome,env:{}}).discover())[0].metadataFidelity,'reduced');
  const absentRoot = join(root,'absent'); const diagnostics=[];
  assert.deepEqual(await new CodexSessionAdapter({root:absentRoot,onDiagnostic:d=>diagnostics.push(d)}).discover(),[]);
  assert.equal(diagnostics[0].code,'root-unavailable');
  assert.equal((await new CodexSessionAdapter({root,env:{}}).discover())[0].title,`Codex ${ids[0]}`);
});

test('unsupported SQLite schema and diagnostic caps preserve healthy history with honest reduced metadata', async t => {
  const {root,cwd} = await fixture(t);
  await writeRollout(root,rollout(cwd,ids[0],[completed('UserMessage','u','Healthy',1)]));
  const db = new DatabaseSync(join(root,'state_5.sqlite')); db.exec('CREATE TABLE unrelated (token TEXT)'); db.close();
  const diagnostics = [];
  const adapter = new CodexSessionAdapter({root,onDiagnostic:d=>diagnostics.push(d),limits:{maxDiagnostics:2}});
  assert.equal((await adapter.discover())[0].metadataFidelity,'reduced');
  assert.deepEqual(texts(await adapter.readHistoryDetailed(ids[0])),['Healthy']);
  assert.ok(diagnostics.some(d=>d.code==='metadata-schema'));
  const before = await tree(root); await adapter.readHistory(ids[0]); assert.deepEqual(await tree(root),before);
});


test('offline process with poisoned provider binaries returns identical data and never launches a provider', async t => {
  const {root,cwd} = await fixture(t);
  await writeRollout(root,rollout(cwd,ids[0],[completed('UserMessage','u','Offline public',1)]));
  const bin = join(root,'bin'); await mkdir(bin);
  const marker = join(root,'provider-invoked');
  for (const name of ['codex','claude']) await writeFile(join(bin,name),`#!/bin/sh\nprintf invoked > '${marker}'\nexit 90\n`,{mode:0o700});
  const expected = await new CodexSessionAdapter({root}).readHistoryDetailed(ids[0]);
  const before = await tree(root);
  const result = spawnSync(process.execPath,['test/fixtures/codex/offline.mjs'],{encoding:'utf8',env:{...process.env,PATH:bin,AGENTSWITCH_FIXTURE_ROOT:root}});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).history,expected);
  assert.deepEqual(await tree(root),before);
});

test('continuously changing metadata stamps stop after bounded retries and preserve reduced-fidelity sessions', async t => {
  const {root,cwd} = await fixture(t);
  const path = await writeRollout(root,rollout(cwd,ids[0],[completed('UserMessage','u','Healthy',1)]));
  await metadata(root,[[ids[0],path,cwd,'Native name']]);
  const alias = join(root,'fixture-alias'); await symlink(root,alias);
  const before = await tree(root);
  const result = spawnSync(process.execPath,['test/fixtures/codex/offline.mjs'],{encoding:'utf8',env:{...process.env,AGENTSWITCH_FIXTURE_ROOT:alias,AGENTSWITCH_UNSTABLE_METADATA:'1'}});
  assert.equal(result.status,0,result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.sessions[0].metadataFidelity,'reduced');
  assert.deepEqual(texts(output.history),['Healthy']);
  assert.equal(output.metadataStats,12); // Two catalog refreshes, three before/after-copy attempts each.
  assert.ok(output.diagnostics.some(d=>d.code==='metadata-unstable'));
  assert.deepEqual(await tree(root),before);
});

test('lazy discovery retains capped histories; oversized lines, depth and diagnostic volume are bounded', async t => {
  const {root,cwd} = await fixture(t);
  const records = rollout(cwd,ids[0],[completed('UserMessage','u','x'.repeat(2000),1)]);
  const path = await writeRollout(root,records);
  const capped = new CodexSessionAdapter({root,limits:{maxFileBytes:1000}});
  assert.equal((await capped.discover()).length,1);
  assert.equal((await capped.readHistoryDetailed(ids[0])).complete,false);
  const lines = new CodexSessionAdapter({root,limits:{maxLineBytes:1000}});
  const result = await lines.readHistoryDetailed(ids[0]);
  assert.deepEqual(result.items,[]); assert.ok(result.diagnostics.some(d=>d.code==='input-limit'));
  await writeFile(path,Buffer.concat([encode(records.slice(0,1)),Buffer.from('{PRIVATE\n'.repeat(20))]));
  const noisy = await new CodexSessionAdapter({root,limits:{maxDiagnostics:3}}).readHistoryDetailed(ids[0]);
  assert.equal(noisy.diagnostics.length,3); assert.equal(noisy.diagnostics[2].code,'diagnostic-limit');
  assert.doesNotMatch(JSON.stringify(noisy),/PRIVATE/);
  await writeFile(path,encode(records));
  await writeRollout(root,rollout(cwd,ids[1],[completed('AgentMessage','c','Child',3)],{history_base:{thread_id:ids[0],end_ordinal_exclusive:2,end_byte_offset:encode(records).length}}));
  const depth = await new CodexSessionAdapter({root,limits:{maxDepth:1}}).readHistoryDetailed(ids[1]);
  assert.equal(depth.complete,false); assert.deepEqual(texts(depth),['Child']);
});

test('concurrent catalog and lazy reads keep their selected identities', async t => {
  const {root,cwd} = await fixture(t);
  await writeRollout(root,rollout(cwd,ids[0],[completed('UserMessage','one','One',1)]));
  await writeRollout(root,rollout(cwd,ids[1],[completed('UserMessage','two','Two',1)]));
  const adapter = new CodexSessionAdapter({root});
  const results = await Promise.all([adapter.discover(),adapter.readHistoryDetailed(ids[0]),adapter.discover(),adapter.readHistoryDetailed(ids[1])]);
  assert.equal(results[0].length,2); assert.deepEqual(texts(results[1]),['One']);
  assert.equal(results[2].length,2); assert.deepEqual(texts(results[3]),['Two']);
});

test('tool text variants match pinned schema and explicit public errors survive', async t => {
  const {root,cwd} = await fixture(t);
  await writeRollout(root,rollout(cwd,ids[0],[
    completed('DynamicToolCall','d','',1,{status:'completed',content_items:[{type:'inputText',text:'Dynamic text'},{type:'inputImage',imageUrl:'PRIVATE_IMAGE'},{type:'text',text:'PRIVATE_WRONG_TAG'}]}),
    completed('McpToolCall','m','',2,{status:'failed',error:{message:'Public MCP failure'}}),
    completed('FunctionCallOutput','f','',3,{output:[{type:'input_text',text:'Function text'},{type:'output_text',text:'PRIVATE_WRONG_FUNCTION_TAG'}]}),
  ]));
  const result = await new CodexSessionAdapter({root}).readHistoryDetailed(ids[0]);
  assert.deepEqual(texts(result),['Dynamic text','Public MCP failure','Function text']);
  assert.equal(result.items[1].status,'failed'); assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);
});

test('standalone subagent display start excludes inherited context without a history_base', async t => {
  const {root,cwd} = await fixture(t);
  await writeRollout(root,rollout(cwd,ids[0],[completed('UserMessage','context','PRIVATE_INHERITED_CONTEXT',1),completed('AgentMessage','public','Own answer',2)],{subagent_history_start_ordinal:2}));
  const result = await new CodexSessionAdapter({root}).readHistoryDetailed(ids[0]);
  assert.equal(result.complete,true); assert.deepEqual(texts(result),['Own answer']);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);
});

test('legacy distinct SQLite titles precede indexed names, with Guardian default and derived-preview exceptions', async t => {
  const {root,cwd} = await fixture(t);
  const path = await writeRollout(root,rollout(cwd,ids[0],[],{history_mode:'legacy'}));
  await metadata(root,[[ids[0],path,cwd,'Ignored paginated name']]);
  await writeFile(join(root,'session_index.jsonl'),`${JSON.stringify({id:ids[0],thread_name:'Indexed name'})}\n`);
  const db = new DatabaseSync(join(root,'state_5.sqlite'));
  db.exec('ALTER TABLE threads ADD COLUMN first_user_message TEXT; ALTER TABLE threads ADD COLUMN source TEXT');
  db.prepare('UPDATE threads SET title=?, first_user_message=?, source=?').run('Distinct native title','Derived preview','"cli"');
  const adapter = new CodexSessionAdapter({root});
  assert.equal((await adapter.discover())[0].title,'Distinct native title');
  db.prepare('UPDATE threads SET title=?, first_user_message=?').run('Derived preview','Derived preview');
  assert.equal((await adapter.discover())[0].title,'Indexed name');
  db.prepare('UPDATE threads SET title=?, source=?').run('Guardian review',JSON.stringify({subagent:{other:'guardian'}}));
  assert.equal((await adapter.discover())[0].title,'Indexed name'); db.close();
});

test('invalid display ordinals and explicit null history mode are rejected beside healthy sessions', async t => {
  const {root,cwd} = await fixture(t);
  await writeRollout(root,rollout(cwd,ids[0],[completed('UserMessage','u','Healthy',1)]));
  await writeRollout(root,rollout(cwd,ids[1],[completed('UserMessage','private','PRIVATE_CONTEXT',1)],{subagent_history_start_ordinal:-1}));
  await writeRollout(root,rollout(cwd,ids[2],[],{history_mode:null}));
  const diagnostics=[];
  const sessions = await new CodexSessionAdapter({root,onDiagnostic:d=>diagnostics.push(d)}).discover();
  assert.deepEqual(sessions.map(s=>s.nativeId),[ids[0]]);
  assert.ok(diagnostics.some(d=>d.code==='unsupported-shape')); assert.ok(diagnostics.some(d=>d.code==='unsupported-mode'));
  assert.doesNotMatch(JSON.stringify({sessions,diagnostics}),/PRIVATE_/);
});

test('public paginated plans retain assistant text, native identity and status without reasoning', async t => {
  const {root,cwd} = await fixture(t);
  await writeRollout(root,rollout(cwd,ids[0],[
    completed('UserMessage','u','Request',1),
    completed('Plan','plan-public-1','',2,{text:'PLAN_PUBLIC_MARKER'}),
    completed('Reasoning','reason','PRIVATE_REASON',3,{text:'PRIVATE_REASON_TEXT'}),
    completed('AgentMessage','a','Answer',4),
  ]));
  const adapter = new CodexSessionAdapter({root});
  const history = await adapter.readHistoryDetailed(ids[0]);
  assert.equal(history.complete,true);
  assert.deepEqual(history.items,[{id:`codex:${ids[0]}:u`,role:'user',text:'Request',status:'complete'},{id:`codex:${ids[0]}:plan-public-1`,role:'assistant',text:'PLAN_PUBLIC_MARKER',status:'complete'},{id:`codex:${ids[0]}:a`,role:'assistant',text:'Answer',status:'complete'}]);
  assert.deepEqual(await adapter.readHistory(ids[0]),history.items);
  assert.doesNotMatch(JSON.stringify(history),/PRIVATE_/);
});

function observedReads(root,limits,nativeId,env = {}) {
  const result = spawnSync(process.execPath,['test/fixtures/codex/read-budget.mjs'],{encoding:'utf8',env:{...process.env,AGENTSWITCH_FIXTURE_ROOT:root,AGENTSWITCH_READ_LIMITS:JSON.stringify(limits),...(nativeId ? {AGENTSWITCH_READ_ID:nativeId} : {}),...env}});
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}
function withinBudget(output,budget) {
  let total = 0;
  for (const read of output.reads) {assert.ok(read.requested <= budget - total,`requested ${read.requested} with ${budget-total} remaining`); total += read.bytes;}
  assert.ok(total <= budget);
}

test('large session metadata is discovered in a few bounded reads', async t => {
  const {root,cwd} = await fixture(t);
  const records = rollout(cwd,ids[0],[],{fixturePadding:'x'.repeat(64 * 1024)});
  await writeRollout(root,records);
  const budget = encode(records).length;
  const output = observedReads(root,{maxScanBytes:budget});
  withinBudget(output,budget);
  assert.equal(output.result.length,1);
  assert.ok(output.reads.length < 10);
});

test('native header read requests and transferred bytes stay within the remaining operation budget', async t => {
  const {root,cwd} = await fixture(t);
  const records = rollout(cwd,ids[0],[completed('UserMessage','u','x'.repeat(100000),1)]);
  await writeRollout(root,records);
  await writeRollout(root,rollout(cwd,ids[1],[completed('UserMessage','u','x'.repeat(100000),1)]));
  const budget = encode(records.slice(0,1)).length + 40;
  const output = observedReads(root,{maxLineBytes:65536,maxScanBytes:budget});
  withinBudget(output,budget);
  assert.equal(output.result.length,1); assert.ok(output.diagnostics.some(d=>d.code==='input-limit'));
});

for (const source of ['database','index','wal']) {
  test(`native ${source} bytes are charged before reads without losing a fitting healthy header`, async t => {
    const {root,cwd} = await fixture(t);
    const records = rollout(cwd,ids[0],[],{history_mode:source === 'index' ? 'legacy' : 'paginated'});
    const path = await writeRollout(root,records);
    let prefix = 0, db;
    if (source === 'database') await metadata(root,[[ids[0],path,cwd,'Native title']]);
    if (source === 'index') await writeFile(join(root,'session_index.jsonl'),`${JSON.stringify({id:ids[0],thread_name:'x'.repeat(10000)})}\n`);
    if (source === 'wal') {
      db = new DatabaseSync(join(root,'state_5.sqlite')); t.after(()=>db.close());
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0'); schema(db); row(db,ids[0],path,cwd,'Native title');
      prefix = (await readFile(join(root,'state_5.sqlite'))).length;
    }
    const budget = prefix + encode(records.slice(0,1)).length + 40;
    const before = await tree(root);
    const output = observedReads(root,{maxScanBytes:budget});
    withinBudget(output,budget);
    assert.equal(output.result.length,1); assert.equal(output.result[0].metadataFidelity,'reduced');
    assert.equal(output.result[0].title,`Codex ${ids[0]}`);
    assert.ok(output.diagnostics.some(d=>d.code==='input-limit'));
    assert.deepEqual(await tree(root),before);
  });
}

test('one public lazy read shares its native byte budget with discovery and metadata', async t => {
  const {root,cwd} = await fixture(t);
  const records = rollout(cwd,ids[0],[completed('UserMessage','u','x'.repeat(1000),1)]);
  await writeRollout(root,records);
  const budget = encode(records).length;
  const output = observedReads(root,{maxScanBytes:budget},ids[0]);
  withinBudget(output,budget);
  assert.equal(output.result.complete,false); assert.ok(output.result.diagnostics.some(d=>d.code==='input-limit'));
});


test('snapshot retry reads spend the same operation budget and leave room for fitting headers', async t => {
  const {root,cwd} = await fixture(t);
  const records = rollout(cwd,ids[0],[]);
  const path = await writeRollout(root,records);
  await metadata(root,[[ids[0],path,cwd,'Native title']]);
  const dbBytes = (await readFile(join(root,'state_5.sqlite'))).length;
  const budget = 2 * dbBytes + encode(records.slice(0,1)).length + 40;
  const alias = join(root,'fixture-alias'); await symlink(root,alias);
  const output = observedReads(alias,{maxScanBytes:budget},undefined,{AGENTSWITCH_UNSTABLE_METADATA:'1'});
  withinBudget(output,budget);
  assert.equal(output.result.length,1); assert.equal(output.result[0].metadataFidelity,'reduced');
  assert.equal(output.reads.filter(read=>read.path==='state_5.sqlite').reduce((sum,read)=>sum+read.bytes,0),2*dbBytes);
  assert.ok(output.diagnostics.some(d=>d.code==='input-limit'));
});

test('a final header without newline fits an exact native-read budget', async t => {
  const {root,cwd} = await fixture(t);
  const records = rollout(cwd,ids[0],[]);
  const path = await writeRollout(root,records);
  const bytes = encode(records).subarray(0,-1); await writeFile(path,bytes);
  const output = observedReads(root,{maxScanBytes:bytes.length});
  withinBudget(output,bytes.length); assert.equal(output.result.length,1);
});

for (const formats of [['plain','plain'],['zstd','zstd'],['zstd','plain']]) {
  test(`decoded lineage budget is aggregate across ${formats.join('+')} and resets for each read`, async t => {
    const {root,cwd} = await fixture(t);
    const parentRecords = rollout(cwd,ids[0],[completed('UserMessage','parent','P'.repeat(1000),1)]);
    const parentBytes = encode(parentRecords), parentPath = await writeRollout(root,parentRecords);
    const base = {thread_id:ids[0],end_ordinal_exclusive:2,end_byte_offset:parentBytes.length};
    const childRecords = rollout(cwd,ids[1],[completed('AgentMessage','child','C'.repeat(1000),3)],{history_base:base});
    const childBytes = encode(childRecords), childPath = await writeRollout(root,childRecords);
    for (const [index,path,bytes] of [[0,parentPath,parentBytes],[1,childPath,childBytes]]) {
      if (formats[index] === 'zstd') {await writeFile(`${path}.zst`,zstdCompressSync(bytes)); await rm(path);}
    }
    const limit = Math.max(parentBytes.length,childBytes.length) + 40;
    assert.ok(parentBytes.length < limit && childBytes.length < limit && parentBytes.length + childBytes.length > limit);
    const before = await tree(root);
    const capped = new CodexSessionAdapter({root,limits:{maxDecodedBytes:limit}});
    const result = await capped.readHistoryDetailed(ids[1]);
    assert.equal(result.complete,false);
    assert.deepEqual(texts(result),['C'.repeat(1000)]);
    assert.ok(result.diagnostics.some(d=>d.code==='input-limit'));
    assert.deepEqual(await capped.readHistoryDetailed(ids[1]),result);
    const exact = await new CodexSessionAdapter({root,limits:{maxDecodedBytes:parentBytes.length+childBytes.length}}).readHistoryDetailed(ids[1]);
    assert.equal(exact.complete,true); assert.deepEqual(texts(exact),['P'.repeat(1000),'C'.repeat(1000)]);
    assert.deepEqual(await tree(root),before);
  });
}
