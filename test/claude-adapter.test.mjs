import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink,utimes,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import * as adapters from '../dist/adapters/index.js';
import {ids,stamp,entry,encode,parallel} from './fixtures/claude/native.mjs';
const reader = options => {assert.equal(typeof adapters.ClaudeSessionAdapter,'function','ClaudeSessionAdapter must be exported'); return new adapters.ClaudeSessionAdapter(options);};
async function fixture(t) {
  const base=await mkdtemp(join(tmpdir(),'agentswitch-claude-')); t.after(()=>rm(base,{recursive:true,force:true}));
  const root=join(base,'config'),cwd=join(base,'workspace'); await mkdir(root); await mkdir(cwd);
  return {base,root,cwd};
}
async function write(root,id,records,bucket='lossy-not-a-workspace') {
  const dir=join(root,'projects',bucket); await mkdir(dir,{recursive:true}); const file=join(dir,`${id}.jsonl`);
  await writeFile(file,encode(records)); await utimes(file,new Date(stamp),new Date(stamp)); return file;
}
async function tree(root) {
  const result={};
  async function visit(dir) {for(const name of (await readdir(dir)).sort()) {const path=join(dir,name),info=await stat(path);if(info.isDirectory()){result[path]='directory';await visit(path);}else result[path]=(await readFile(path)).toString('base64');}}
  await visit(root); return result;
}
const texts = result => result.items.map(i=>i.text);
const e=(id,cwd,uuid,parent,type,content,extra)=>entry(id,cwd,uuid,parent,type,content,extra);

test('metadata preserves native IDs, canonical workspace, exact folder scope and last title precedence',async t=>{
  const {base,root,cwd}=await fixture(t),other=join(base,'other'),child=join(cwd,'child'),alias=join(base,'alias');
  await mkdir(other);await mkdir(child);await symlink(cwd,alias);
  await write(root,ids[0],[e(ids[0],alias,'u',null,'user','First prompt'),{type:'summary',summary:'Summary'},{type:'last-prompt',lastPrompt:'Last'},{type:'ai-title',aiTitle:'AI'},{type:'custom-title',customTitle:'Old'},{type:'custom-title',customTitle:'Same title'}]);
  const f=await write(root,ids[1],[e(ids[1],cwd,'u',null,'user','Different prompt'),{type:'custom-title',customTitle:'Same title'}],'other-bucket');
  await write(root,ids[2],[e(ids[2],other,'u',null,'user','Other')]);
  await write(root,ids[3],[e(ids[3],child,'u',null,'user','Child')]);
  await utimes(f,new Date(stamp),new Date('2026-11-21T12:00:00Z'));
  const a=reader({root}),sessions=await a.discover();
  assert.deepEqual(sessions.map(s=>s.nativeId),[ids[1],ids[0],ids[2],ids[3]]);
  assert.deepEqual(sessions.filter(s=>s.workspace===cwd).map(s=>s.nativeId),[ids[1],ids[0]]);
  assert.equal(sessions[0].title,'Same title');assert.equal(sessions[1].title,'Same title');
  assert.equal(sessions[1].workspace,cwd);assert.equal(sessions[0].updatedAt,'2026-11-21T12:00:00.000Z');
  assert.equal(sessions[0].createdAt,stamp);assert.deepEqual(sessions.map(s=>s.messages),[[],[],[],[]]);
  assert.equal(sessions[0].id,`claude:${ids[1]}`);
});

test('explicit config root overrides environment, then home; root aliases resolve',async t=>{
  const {base,root,cwd}=await fixture(t),envRoot=join(base,'environment'),home=join(base,'home'),alias=join(base,'root-alias');
  await write(root,ids[0],[e(ids[0],cwd,'u',null,'user','Explicit')]);
  await write(envRoot,ids[1],[e(ids[1],cwd,'u',null,'user','Environment')]);
  await write(join(home,'.claude'),ids[2],[e(ids[2],cwd,'u',null,'user','Home')]);await symlink(root,alias);
  const env={CLAUDE_CONFIG_DIR:envRoot};
  assert.deepEqual((await reader({root:alias,home,env}).discover()).map(s=>s.nativeId),[ids[0]]);
  assert.deepEqual((await reader({home,env}).discover()).map(s=>s.nativeId),[ids[1]]);
  assert.deepEqual((await reader({home,env:{CLAUDE_CONFIG_DIR:''}}).discover()).map(s=>s.nativeId),[ids[2]]);
});

test('active branch restores parallel outcomes while projecting only public blocks with stable native positions',async t=>{
  const {root,cwd}=await fixture(t);await write(root,ids[0],parallel(ids[0],cwd)); const diagnostics=[];
  const a=reader({root,onDiagnostic:d=>diagnostics.push(d)}),result=await a.readHistoryDetailed(ids[0]);
  assert.deepEqual(result.items,[
    {id:`claude:${ids[0]}:u:block-0`,role:'user',text:'Request',status:'complete'},
    {id:`claude:${ids[0]}:a:block-1`,role:'assistant',text:'Working',status:'complete'},
    {id:`claude:${ids[0]}:r1:block-0:text-0`,role:'tool',text:'Second result',status:'complete'},
    {id:`claude:${ids[0]}:r0:block-0`,role:'tool',text:'First failed',status:'failed'},
    {id:`claude:${ids[0]}:z:block-0`,role:'assistant',text:'Done',status:'complete'},
  ]);
  assert.deepEqual(await a.readHistory(ids[0]),result.items);assert.deepEqual(await a.readHistoryDetailed(ids[0]),result);
  assert.doesNotMatch(JSON.stringify({result,diagnostics,sessions:await a.discover()}),/PRIVATE_/);
});

test('compaction retains summary and never follows logicalParentUuid; only explicit interruption sets status',async t=>{
  const {root,cwd}=await fixture(t);await write(root,ids[0],[
    e(ids[0],cwd,'old',null,'user','PRIVATE_OLD'),e(ids[0],cwd,'boundary',null,'system',undefined,{logicalParentUuid:'old',subtype:'compact_boundary'}),
    e(ids[0],cwd,'compact','boundary','user','Summary retained',{isCompactSummary:true}),
    e(ids[0],cwd,'i','compact','user','[Request interrupted by user for tool use]'),
    e(ids[0],cwd,'a','i','assistant','EOF answer'),
  ]);
  const r=await reader({root}).readHistoryDetailed(ids[0]);assert.deepEqual(texts(r),['Summary retained','[Request interrupted by user for tool use]','EOF answer']);
  assert.deepEqual(r.items.map(i=>i.status),['complete','interrupted','complete']);assert.equal(r.complete,true);
});

test('latest main leaf follows file position, including trailing system ancestry',async t=>{
  const {root,cwd}=await fixture(t);await write(root,ids[0],[e(ids[0],cwd,'u',null,'user','Request'),e(ids[0],cwd,'a','u','assistant','Wrong',{timestamp:'2030-01-01'}),e(ids[0],cwd,'b','u','assistant','Right',{timestamp:'2000-01-01'}),e(ids[0],cwd,'p','b','progress',undefined)]);
  assert.deepEqual(texts(await reader({root}).readHistoryDetailed(ids[0])),['Request','Right']);
});

test('stray result recovery uses call identity, avoids answered duplicates and other writers',async t=>{
  const {root,cwd}=await fixture(t);const records=parallel(ids[0],cwd).slice(0,8);
  records.splice(5,1); // call1 result is absent from main graph
  records.push(e(ids[0],cwd,'stray','old','user',[{type:'tool_result',tool_use_id:'call1',content:'Recovered'}],{sourceToolAssistantUUID:'c1'}));
  records.push(e(ids[0],cwd,'duplicate','old','user',[{type:'tool_result',tool_use_id:'call0',content:'PRIVATE_DUPLICATE'}]));
  records.push(e(ids[0],cwd,'foreign','old','user',[{type:'tool_result',tool_use_id:'call1',content:'PRIVATE_FOREIGN'}],{isSidechain:true,agentId:'other'}));
  // Keep Z the most recent main leaf; strays must not become chosen active turn.
  records.push(e(ids[0],cwd,'end','z','assistant','Final'));
  await write(root,ids[0],records);const r=await reader({root}).readHistoryDetailed(ids[0]);
  assert.deepEqual(texts(r),['Request','Working','Recovered','First failed','Done','Final']);assert.doesNotMatch(JSON.stringify(r),/PRIVATE_/);
});

test('bad records, unknown versions and shapes are isolated with bounded payload-free diagnostics',async t=>{
  const {root,cwd}=await fixture(t),diagnostics=[];
  const damaged=await write(root,ids[0],[e(ids[0],cwd,'u',null,'user','Healthy',{version:'99.0.0'}),'{PRIVATE_BROKEN',
    e(ids[0],cwd,'bad','u','user','PRIVATE_BAD_PARENT',{parentUuid:{private:'PRIVATE_OBJECT'}}),
    e(ids[1],cwd,'mismatch','u','user','PRIVATE_IDENTITY'),{type:'future-private',payload:'PRIVATE_UNKNOWN'},
    e(ids[0],cwd,'a','u','assistant',[{type:'future-block',value:'PRIVATE_BLOCK'},{type:'text',text:'Survived'}]),'{PRIVATE_PARTIAL']);
  await writeFile(damaged,(await readFile(damaged)).subarray(0,-1));
  await write(root,ids[1],['{PRIVATE_CORRUPT']);
  await write(root,ids[2],[e(ids[2],'relative','u',null,'user','PRIVATE_NO_CWD')]);
  const a=reader({root,onDiagnostic:d=>diagnostics.push(d),limits:{maxDiagnostics:8}}),sessions=await a.discover();
  assert.deepEqual(sessions.map(s=>s.nativeId),[ids[0]]);
  diagnostics.length=0;const r=await a.readHistoryDetailed(ids[0]);assert.deepEqual(texts(r),['Healthy','Survived']);assert.equal(r.complete,false);
  assert.ok(r.diagnostics.some(d=>d.code==='malformed-record'));assert.ok(r.diagnostics.some(d=>d.code==='partial-record'));
  assert.ok(diagnostics.length<=8);assert.doesNotMatch(JSON.stringify({r,diagnostics,sessions}),/PRIVATE_|relative/);assert.doesNotMatch(JSON.stringify(diagnostics),/99\.0\.0/);
});

test('oversized lines retain later healthy metadata and graph; file cap reports recovered prefix',async t=>{
  const {root,cwd}=await fixture(t);await write(root,ids[0],[{type:'queue-operation',data:'PRIVATE_'+'x'.repeat(5000)},e(ids[0],cwd,'u',null,'user','Healthy'),e(ids[0],cwd,'a','u','assistant','Answer')]);
  const a=reader({root,limits:{maxLineBytes:1000}});assert.equal((await a.discover()).length,1);
  const r=await a.readHistoryDetailed(ids[0]);assert.deepEqual(texts(r),['Healthy','Answer']);assert.equal(r.complete,false);assert.ok(r.diagnostics.some(d=>d.code==='input-limit'));
  await write(root,ids[1],[e(ids[1],cwd,'u',null,'user','Prefix'),e(ids[1],cwd,'a','u','assistant','x'.repeat(10000))]);
  const limited=reader({root,limits:{maxFileBytes:1000}});assert.ok((await limited.discover()).some(s=>s.nativeId===ids[1]));
  const cap=await limited.readHistoryDetailed(ids[1]);assert.deepEqual(texts(cap),['Prefix']);assert.equal(cap.complete,false);
});

test('duplicate native IDs choose newer file deterministically; invalid names, subagents and symlinks excluded',async t=>{
  const {base,root,cwd}=await fixture(t),diagnostics=[];
  await write(root,ids[0],[e(ids[0],cwd,'u',null,'user','Older')],'a');
  const newer=await write(root,ids[0],[e(ids[0],cwd,'u',null,'user','Newer')],'z');await utimes(newer,new Date(stamp),new Date('2026-11-21'));
  await write(root,ids[1],[e(ids[1],cwd,'u',null,'user','PRIVATE_SUBAGENT')],'a/subagents');
  await write(root,'not-a-uuid',[e(ids[2],cwd,'u',null,'user','PRIVATE_INVALID')]);
  const outside=join(base,'outside');await write(outside,ids[3],[e(ids[3],cwd,'u',null,'user','PRIVATE_OUTSIDE')]);await symlink(join(outside,'projects','lossy-not-a-workspace'),join(root,'projects','escape'));
  const a=reader({root,onDiagnostic:d=>diagnostics.push(d)});assert.deepEqual((await a.discover()).map(s=>s.nativeId),[ids[0]]);
  assert.deepEqual(texts(await a.readHistoryDetailed(ids[0])),['Newer']);assert.ok(diagnostics.some(d=>d.code==='unsupported-shape'));assert.ok(diagnostics.some(d=>d.code==='unsafe-path'));
  assert.deepEqual(await a.readHistory('../outside'),[]);
});

test('cycles and missing parents yield finite incomplete reads; valid siblings remain available',async t=>{
  const {root,cwd}=await fixture(t);await write(root,ids[0],[e(ids[0],cwd,'a','b','user','Cycle A'),e(ids[0],cwd,'b','a','assistant','Cycle B')]);
  await write(root,ids[1],[e(ids[1],cwd,'u','missing','user','Readable')]);
  const a=reader({root});const cycle=await a.readHistoryDetailed(ids[0]);assert.equal(cycle.complete,false);assert.deepEqual(cycle.items,[]);assert.ok(cycle.diagnostics.some(d=>d.code==='ancestry-cycle'));
  const missing=await a.readHistoryDetailed(ids[1]);assert.deepEqual(texts(missing),['Readable']);assert.equal(missing.complete,false);
});

test('spilled references stay public inline text with omission diagnostic and no path dereference',async t=>{
  const {root,cwd}=await fixture(t);await write(root,ids[0],[e(ids[0],cwd,'u',null,'user','Request'),e(ids[0],cwd,'r','u','user',[{type:'tool_result',tool_use_id:'call',content:'<persisted-output>Output saved to: /PRIVATE_PATH</persisted-output>'}],{toolUseResult:{path:'/PRIVATE_OPAQUE'}})]);
  const r=await reader({root}).readHistoryDetailed(ids[0]);assert.match(r.items[1].text,/persisted-output/);assert.equal(r.complete,false);assert.ok(r.diagnostics.some(d=>d.code==='unsupported-shape'));assert.doesNotMatch(JSON.stringify(r.diagnostics),/PRIVATE_/);
});

test('offline process denies network and subprocess APIs and preserves every native fixture byte',async t=>{
  const {root,cwd}=await fixture(t);await write(root,ids[0],parallel(ids[0],cwd));await writeFile(join(root,'.credentials.json'),'PRIVATE_CREDENTIALS');await writeFile(join(root,'settings.json'),'PRIVATE_SETTINGS');const before=await tree(root);
  const ordinary=reader({root}),expected={sessions:await ordinary.discover(),history:await ordinary.readHistoryDetailed(ids[0])};
  const result=spawnSync(process.execPath,['test/fixtures/claude/offline.mjs'],{encoding:'utf8',env:{...process.env,AGENTSWITCH_FIXTURE_ROOT:root}});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),expected);assert.deepEqual(await tree(root),before);
});

test('valid final JSON without newline and appended partial completion refresh in the same adapter',async t=>{
  const {root,cwd}=await fixture(t);const file=await write(root,ids[0],[e(ids[0],cwd,'u',null,'user','First')]);
  await writeFile(file,(await readFile(file)).subarray(0,-1));const a=reader({root});assert.equal((await a.readHistoryDetailed(ids[0])).complete,true);
  const prefix=await readFile(file),answer=JSON.stringify(e(ids[0],cwd,'a','u','assistant','Completed'));
  await writeFile(file,Buffer.concat([prefix,Buffer.from('\n'+answer.slice(0,-2))]));const partial=await a.readHistoryDetailed(ids[0]);assert.equal(partial.complete,false);assert.deepEqual(texts(partial),['First']);
  await writeFile(file,Buffer.concat([prefix,Buffer.from('\n'+answer)]));const complete=await a.readHistoryDetailed(ids[0]);assert.equal(complete.complete,true);assert.deepEqual(texts(complete),['First','Completed']);assert.equal(complete.items[0].id,partial.items[0].id);
});

test('a corrupt sibling does not make selected healthy history incomplete; diagnostics suppress payloads',async t=>{
  const {root,cwd}=await fixture(t),diagnostics=[];await write(root,ids[0],[e(ids[0],cwd,'u',null,'user','Healthy')]);await write(root,ids[1],['{PRIVATE_CORRUPT']);
  const a=reader({root,onDiagnostic:d=>diagnostics.push(d)}),result=await a.readHistoryDetailed(ids[0]);
  assert.equal(result.complete,true);assert.deepEqual(result.diagnostics,[]);assert.ok(diagnostics.some(d=>d.code==='malformed-record'));
});

test('unknown records and nested tool input cannot spoof native display metadata',async t=>{
  const {root,cwd}=await fixture(t),diagnostics=[];await write(root,ids[0],[
    {type:'future-private',cwd:'/PRIVATE_FAKE',customTitle:'PRIVATE_TITLE',timestamp:'2030-01-01'},
    e(ids[0],cwd,'u',null,'user','Real prompt'),
    e(ids[0],cwd,'a','u','assistant',[{type:'tool_use',input:{cwd:'/PRIVATE_CWD',customTitle:'PRIVATE_INPUT_TITLE'}}]),
  ]);
  const sessions=await reader({root,onDiagnostic:d=>diagnostics.push(d)}).discover();assert.equal(sessions[0].workspace,cwd);assert.equal(sessions[0].title,'Real prompt');assert.equal(sessions[0].createdAt,stamp);assert.doesNotMatch(JSON.stringify({sessions,diagnostics}),/PRIVATE_/);
});

test('producer version is optional; only recognized semantic-version metadata is exposed',async t=>{
  const {root,cwd}=await fixture(t),diagnostics=[];await write(root,ids[0],[e(ids[0],cwd,'u',null,'user','No version')]);await write(root,ids[1],[e(ids[1],cwd,'u',null,'user','Known',{version:'2.1.330'})]);await write(root,ids[2],[e(ids[2],cwd,'u',null,'user','Invalid',{version:'PRIVATE_VERSION'})]);
  const sessions=await reader({root,onDiagnostic:d=>diagnostics.push(d)}).discover();assert.equal(sessions.length,3);assert.equal(sessions[0].producerVersion,undefined);assert.equal(sessions[1].producerVersion,'2.1.330');assert.equal(sessions[2].producerVersion,undefined);assert.ok(diagnostics.some(d=>d.code==='unsupported-shape'));assert.doesNotMatch(JSON.stringify({sessions,diagnostics}),/PRIVATE_/);
});

test('workspace absence retains absolute native path with warning; missing cwd is never process cwd',async t=>{
  const {base,root,cwd}=await fixture(t),missing=join(base,'deleted'),diagnostics=[];
  await write(root,ids[0],[e(ids[0],missing,'u',null,'user','Deleted workspace')]);await write(root,ids[1],[e(ids[1],undefined,'u',null,'user','PRIVATE_NO_CWD')]);
  const sessions=await reader({root,onDiagnostic:d=>diagnostics.push(d)}).discover();assert.equal(sessions.length,1);assert.equal(sessions[0].workspace,missing);assert.ok(diagnostics.some(d=>d.code==='workspace-unavailable'));assert.ok(diagnostics.some(d=>d.code==='metadata-unavailable'));
});

test('same-title session duplicates tie-break deterministically and duplicate message IDs do not duplicate exports',async t=>{
  const {root,cwd}=await fixture(t),diagnostics=[];
  await write(root,ids[0],[e(ids[0],cwd,'u',null,'user','First')],'z');await write(root,ids[0],[e(ids[0],cwd,'u',null,'user','Tie winner'),e(ids[0],cwd,'u',null,'user','PRIVATE_DUPLICATE_MESSAGE')],'a');
  const a=reader({root,onDiagnostic:d=>diagnostics.push(d)});assert.equal((await a.discover())[0].title,'Tie winner');const result=await a.readHistoryDetailed(ids[0]);assert.deepEqual(texts(result),['Tie winner']);assert.equal(result.complete,false);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);
});

test('latest assistant sibling text and tool outcomes survive a tools-as-final-turn fanout',async t=>{
  const {root,cwd}=await fixture(t);const records=parallel(ids[0],cwd).slice(0,7);await write(root,ids[0],records);
  const result=await reader({root}).readHistoryDetailed(ids[0]);assert.deepEqual(texts(result),['Request','Working','Second result','First failed']);
});

test('operation byte budget bounds read requests and retains fitting earlier sessions',async t=>{
  const {root,cwd}=await fixture(t);await write(root,ids[0],[e(ids[0],cwd,'u',null,'user','First')]);await write(root,ids[1],[e(ids[1],cwd,'u',null,'user','x'.repeat(10000))]);
  const result=spawnSync(process.execPath,['test/fixtures/claude/read-budget.mjs'],{encoding:'utf8',env:{...process.env,AGENTSWITCH_FIXTURE_ROOT:root,AGENTSWITCH_BUDGET:'1000'}});assert.equal(result.status,0,result.stderr);
  const out=JSON.parse(result.stdout);let bytes=0;for(const read of out.reads){assert.ok(read.requested<=1000-bytes);bytes+=read.bytes;}assert.ok(bytes<=1000);assert.equal(out.sessions.length,1);assert.ok(out.diagnostics.some(d=>d.code==='input-limit'));
});

test('many malformed rows cap notifications per operation and keep later healthy public records',async t=>{
  const {root,cwd}=await fixture(t),diagnostics=[];
  await write(root,ids[0],[e(ids[0],cwd,'u',null,'user','Healthy'),...Array(500).fill('{PRIVATE_CORRUPT'),e(ids[0],cwd,'a','u','assistant','After damage')]);
  const a=reader({root,limits:{maxDiagnostics:4},onDiagnostic:d=>diagnostics.push(d)});const result=await a.readHistoryDetailed(ids[0]);assert.deepEqual(texts(result),['Healthy','After damage']);assert.equal(diagnostics.length,4);assert.equal(result.diagnostics.length,4);assert.equal(diagnostics.at(-1).code,'diagnostic-limit');assert.equal(result.diagnostics.at(-1).code,'diagnostic-limit');assert.equal(result.complete,false);assert.doesNotMatch(JSON.stringify({diagnostics,result}),/PRIVATE_/);
});

test('invalid lowered limits reject immediately',()=>{
  for(const limits of [{maxScanBytes:0},{maxFiles:1.5},{maxDiagnostics:101},{maxFileBytes:Infinity}]) assert.throws(()=>reader({root:'/synthetic',limits}),RangeError);
});

test('hidden terminal records preserve their public ancestry when no public terminal remains',async t=>{
  const {root,cwd}=await fixture(t);await write(root,ids[0],[e(ids[0],cwd,'u',null,'user','Request'),e(ids[0],cwd,'a','u','assistant','Answer'),e(ids[0],cwd,'meta','a','user','PRIVATE_META',{isMeta:true})]);
  const result=await reader({root}).readHistoryDetailed(ids[0]);assert.deepEqual(texts(result),['Request','Answer']);assert.equal(result.complete,true);
});

test('direct sidechain/team transcripts are not promoted to top-level resumable sessions',async t=>{
  const {root,cwd}=await fixture(t);await write(root,ids[0],[e(ids[0],cwd,'u',null,'user','Healthy')]);await write(root,ids[1],[e(ids[1],cwd,'u',null,'user','PRIVATE_SIDECHAIN',{isSidechain:true})]);await write(root,ids[2],[e(ids[2],cwd,'u',null,'user','PRIVATE_TEAM',{teamName:'worker'})]);
  assert.deepEqual((await reader({root}).discover()).map(s=>s.nativeId),[ids[0]]);
});

test('empty native title updates clear earlier values before applying title precedence',async t=>{
  const {root,cwd}=await fixture(t);await write(root,ids[0],[e(ids[0],cwd,'u',null,'user','Prompt'),{type:'custom-title',customTitle:'Old title'},{type:'ai-title',aiTitle:'AI fallback'},{type:'custom-title',customTitle:''}]);
  assert.equal((await reader({root}).discover())[0].title,'AI fallback');
});
