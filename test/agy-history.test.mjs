import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, realpath, writeFile, readdir, symlink, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AgySessionAdapter } from '../dist/adapters/index.js';
import { fixture, user } from './fixtures/agy/native.mjs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { tempDir } from './fixtures/temp.mjs';

async function setup(t, options) {
  const base = await realpath(await tempDir('agentswitch-agy-history-'));
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

// Shapes observed in real agy transcripts (type, source, status and key names only).
const step=(index,type,source,extra={})=>({step_index:index,source,type,status:'DONE',created_at:`2026-11-21T10:00:${String(index).padStart(2,'0')}Z`,...extra});
const call=(name,args)=>({name,args});
const renumber=rows=>rows.forEach((row,i)=>{row.step_index=i;row.created_at=step(i).created_at;});
const toolSession=()=>[
  step(0,'USER_INPUT','USER_EXPLICIT',{content:user('Run the checks')}),
  step(1,'PLANNER_RESPONSE','MODEL',{content:'I will run them',thinking:'PRIVATE_THINKING',model:'m',input_tokens:1,cache_read_tokens:0,output_tokens:1,
    tool_calls:[call('run_command',{CommandLine:'PRIVATE_COMMAND',WaitMsBeforeAsync:0,toolSummary:'PRIVATE_SUMMARY'}),call('read_file',{Path:'/PRIVATE_PATH',StartLine:1,EndLine:2})]}),
  step(2,'GENERIC','MODEL',{content:'PRIVATE_OUTPUT_DONE'}),
  step(3,'GENERIC','MODEL',{content:'PRIVATE_OUTPUT_RUNNING',status:'RUNNING',truncated_fields:['content']}),
  step(4,'SYSTEM_MESSAGE','SYSTEM',{content:'PRIVATE_SYSTEM_MESSAGE'}),
  // Tool names, call shapes and the status of excluded steps are never inspected.
  step(5,'PLANNER_RESPONSE','MODEL',{status:'PRIVATE_FUTURE_STATUS',model:'m',input_tokens:1,cache_read_tokens:0,output_tokens:1,tool_calls:[call('PRIVATE_FUTURE_TOOL','PRIVATE_STRING_ARGS'),{name:'x',args:{},PRIVATE_FIELD:1},
    call('write_file',{Path:'/PRIVATE_W',Content:'PRIVATE_CONTENT',Overwrite:true}),call('edit_file',{Path:'/PRIVATE_E',Target:'PRIVATE_T',Replacement:'PRIVATE_R'}),
    call('invoke_subagent',{Prompt:'PRIVATE_PROMPT',Role:'PRIVATE_ROLE',TypeName:'PRIVATE_TYPE'}),call('define_subagent',{Name:'PRIVATE_NAME',Description:'PRIVATE_D',SystemPrompt:'PRIVATE_SP',EnableWriteTools:false}),
    call('send_message',{Recipient:'PRIVATE_TO',Message:'PRIVATE_MESSAGE'}),call('manage_task',{Action:'PRIVATE_ACTION',TaskId:'PRIVATE_TASK'}),call('schedule',{Prompt:'PRIVATE_SP2',DurationSeconds:1,TimerCondition:'PRIVATE_TC'})]}),
  ...['DONE','ERROR','INVALID','CANCELED','DONE','DONE','DONE'].map((status,i)=>step(6+i,'GENERIC','MODEL',{content:'PRIVATE_RESULT',status,...(status==='ERROR'?{error:'PRIVATE_ERROR'}:{})})),
  // Public content beside tool calls is projected; a tool-call step may have no result steps at all.
  step(13,'PLANNER_RESPONSE','MODEL',{content:'Checks pass',model:'m',input_tokens:1,cache_read_tokens:0,output_tokens:1,tool_calls:[call('read_file',{Path:'/PRIVATE_LAST'})]}),
  step(14,'USER_INPUT','USER_EXPLICIT',{content:user('Thanks')}),
  step(15,'PLANNER_RESPONSE','MODEL',{content:'You are welcome'}),
];
const writeSession=async(f,records,step_count=records.length)=>{
  await fixture(f.root,f.cwd,{nativeId:f.nativeId,records,row:{step_count}});
  return f.adapter.readHistoryDetailed(f.nativeId);
};
test('agy known tool and system steps are excluded while surrounding public text stays complete',async t=>{
  const f=await setup(t),h=await writeSession(f,toolSession());
  assert.equal(h.complete,true);assert.deepEqual(h.diagnostics,[]);
  assert.deepEqual(h.items.map(x=>[x.role,x.text]),[['user','Run the checks'],['assistant','I will run them'],['assistant','Checks pass'],['user','Thanks'],['assistant','You are welcome']]);
  assert.deepEqual(h.excludedSteps,[1,2,3,4,5,6,7,8,9,10,11,12,13]);
  assert.doesNotMatch(JSON.stringify(h),/PRIVATE_|run_command|CommandLine/);
});
for(const [name,mutate] of [
  ['unknown step type',rows=>{rows[4].type='PRIVATE_FUTURE_STEP';}],
  ['system message from the model',rows=>{rows[4].source='MODEL';}],
  ['result after a public answer without a new call',rows=>{rows.splice(15,0,step(15,'GENERIC','MODEL',{content:'PRIVATE_ORPHAN'}));renumber(rows);}],
  ['active public answer beside tool calls',rows=>{rows[13].status='RUNNING';}],
  ['active user request',rows=>{rows[14].status='PRIVATE_STATUS';}],
  ['non-list tool calls',rows=>{rows[1].tool_calls='PRIVATE_CALLS';}],
  ['non-string status',rows=>{rows[2].status=1;}],
  ['turn ending in tool steps',rows=>{rows.splice(15,1,step(15,'PLANNER_RESPONSE','MODEL',{tool_calls:[]}),step(16,'GENERIC','MODEL',{content:'PRIVATE_TAIL'}));}],
])test('agy tool step strictness stays for '+name,async t=>{
  const f=await setup(t),rows=toolSession();mutate(rows);const h=await writeSession(f,rows);
  assert.equal(h.complete,false);assert.deepEqual(h.items,[]);assert.doesNotMatch(JSON.stringify(h),/PRIVATE_/);
});
test('agy writer lag of exactly one step reads complete with a note; other mismatches stay strict',async t=>{
  const f=await setup(t),rows=toolSession();
  const lag=await writeSession(f,rows,rows.length+1);
  assert.equal(lag.complete,true);assert.deepEqual(lag.diagnostics.map(d=>d.code),['step-count-lag']);assert.equal(lag.items.length,5);
  assert.equal((await writeSession(f,rows,rows.length+2)).complete,false);
  assert.equal((await writeSession(f,rows,rows.length-1)).complete,false);
  const gapped=await writeSession(f,rows.map((r,i)=>i>=10?{...r,step_index:i+1}:r),rows.length+1);
  assert.equal(gapped.complete,false);assert.deepEqual(gapped.diagnostics.map(d=>d.code),['invalid-ordinal']);
});
test('agy writer lag note keeps the catalog source healthy, so a removed sibling leaves the index',async t=>{
  const f=await setup(t),rows=toolSession();await writeSession(f,rows,rows.length+1);
  const other=await fixture(f.root,f.cwd,{nativeId:'22345678-1234-4234-8234-123456789abc',user:'Removed sibling needle'});
  const {NativeCatalog}=await import('../dist/native-catalog.js'),{SearchIndex}=await import('../dist/search-index.js');
  const env={AGENTSWITCH_AGY_ROOT:f.root,GROK_HOME:join(f.base,'grok'),CODEX_HOME:join(f.base,'codex'),CLAUDE_CONFIG_DIR:join(f.base,'claude'),OPENCODE_DB:join(f.base,'missing.db'),XDG_DATA_HOME:join(f.base,'xdg')};
  const catalog=await NativeCatalog.create(env),index=await SearchIndex.open({directory:join(f.base,'index'),sources:catalog.sources()});t.after(()=>index.close());
  const q={text:'Removed sibling',agent:'agy',scope:'global',workspace:f.cwd};
  await catalog.refresh(index);assert.equal((await index.query(q)).length,1);assert.equal((await index.query({...q,text:'Checks pass'})).length,1);
  const db=new DatabaseSync(f.path);db.prepare('DELETE FROM conversation_summaries WHERE conversation_id=?').run(other.nativeId);db.close();
  await rm(join(f.root,'brain',other.nativeId),{recursive:true});await writeFile(f.cache,JSON.stringify({[f.cwd]:f.nativeId}));
  await catalog.refresh(index);assert.equal((await index.query(q)).length,0);assert.equal((await index.query({...q,text:'Checks pass'})).length,1);
});
test('agy excluded step notice stays bounded with thousands of excluded steps',async()=>{
  const {excludedStepsSummary}=await import('../dist/native-catalog.js');
  assert.equal(excludedStepsSummary([]),'none');
  assert.equal(excludedStepsSummary([1,2]),'2 (indexes 1–2)');
  assert.equal(excludedStepsSummary([3,4,5,6,7,12,40,41,95]),'9 (indexes 3–7, 12, 40–41, 95)');
  const many=Array.from({length:5000},(_,i)=>i*2+1),summary=excludedStepsSummary(many);
  assert.equal(summary,'5000 (indexes 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, …)');
  assert.equal(excludedStepsSummary(Array.from({length:5000},(_,i)=>i+1)),'5000 (indexes 1–5000)');
});
test('agy native subagent rows are skipped silently and their cached IDs are not re-listed',async t=>{
  const f=await setup(t),other=join(f.base,'subagent-workspace');await mkdir(other);
  const sub='22345678-1234-4234-8234-123456789abc',odd='32345678-1234-4234-8234-123456789abc';
  await fixture(f.root,other,{nativeId:sub,row:{parent_conversation_id:f.nativeId,nesting_depth:1,agent_name:'PRIVATE_AGENT',status:'RUNNING',killed:1,step_count:999}});
  const diagnostics=[],a=new AgySessionAdapter({root:f.root,onDiagnostic:d=>diagnostics.push(d)});
  const sessions=await a.discover();assert.deepEqual(sessions.map(s=>[s.nativeId,s.metadataOnly]),[[f.nativeId,false]]);assert.deepEqual(diagnostics,[]);
  for(const row of [{parent_conversation_id:f.nativeId,nesting_depth:0},{parent_conversation_id:'',nesting_depth:2},{parent_conversation_id:'PRIVATE_NOT_UUID',nesting_depth:1}]) {
    await fixture(f.root,other,{nativeId:odd,row});diagnostics.length=0;
    assert.deepEqual((await a.discover()).map(s=>s.nativeId),[f.nativeId]);assert.deepEqual(diagnostics.map(d=>d.code),['unsupported-mode']);
  }
  assert.doesNotMatch(JSON.stringify([sessions,diagnostics]),/PRIVATE_/);
});
test('agy subagent rows do not count toward the catalog entry limit; listed rows still do',async t=>{
  const f=await setup(t),other=join(f.base,'subagent-workspace');await mkdir(other);
  for(const n of [2,3,4])await fixture(f.root,other,{nativeId:`${n}2345678-1234-4234-8234-123456789abc`,row:{parent_conversation_id:f.nativeId,nesting_depth:1,agent_name:'helper'}});
  await writeFile(f.cache,JSON.stringify({[f.cwd]:f.nativeId,[other]:'42345678-1234-4234-8234-123456789abc'}));
  const diagnostics=[],limited=new AgySessionAdapter({root:f.root,limits:{maxEntries:2},onDiagnostic:d=>diagnostics.push(d)});
  assert.deepEqual((await limited.discover()).map(s=>[s.nativeId,s.metadataOnly]),[[f.nativeId,false]]);assert.deepEqual(diagnostics,[]);
  assert.equal((await limited.readHistoryDetailed(f.nativeId)).complete,true);
  for(const n of [5,6])await fixture(f.root,f.cwd,{nativeId:`${n}2345678-1234-4234-8234-123456789abc`});
  await writeFile(f.cache,JSON.stringify({[f.cwd]:f.nativeId}));diagnostics.length=0;
  assert.deepEqual(await limited.discover(),[]);assert.deepEqual(diagnostics.map(d=>d.code),['input-limit']);
});

test('agy catalog history reads each get their own byte budget and charge the transcript once', async t => {
  const f = await setup(t);
  const files = [f, ...await Promise.all([2, 3].map(n => fixture(f.root, f.cwd, { nativeId: `${n}2345678-1234-4234-8234-123456789abc` })))];
  const sizes = await Promise.all(files.map(async x => (await stat(x.history)).size));
  // Each transcript fits on its own, but neither twice nor together with its siblings.
  const adapter = new AgySessionAdapter({ root: f.root, limits: { maxScanBytes: 2 * Math.min(...sizes) - 1 } });
  const sessions = await adapter.discover();
  assert.equal(sessions.length, 3);
  for (const session of sessions) assert.equal((await adapter.readCatalogHistoryDetailed(session.nativeId)).complete, true, session.nativeId);
});
