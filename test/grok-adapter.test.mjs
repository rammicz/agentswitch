import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,symlink,stat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as adapters from '../dist/adapters/index.js';
import {fixture,id,user} from './fixtures/grok/native.mjs';
async function setup(t){const base=await realpath(await mkdtemp(join(tmpdir(),'agentswitch-grok-')));t.after(()=>rm(base,{recursive:true,force:true}));const root=join(base,'native'),cwd=join(base,'workspace');await mkdir(cwd);const files=await fixture(root,cwd);assert.equal(typeof adapters.GrokSessionAdapter,'function','Grok source adapter must be registered');return {base,root,cwd,...files,adapter:new adapters.GrokSessionAdapter({root})};}
test('Grok v1 public projection is chronological, stable and read only; excludes hidden content',async t=>{
 const f=await setup(t);const before=await Promise.all([f.path,f.history].map(async p=>[await readFile(p),await stat(p)]));
 const [s]=await f.adapter.discover();assert.equal(s.agent,'grok');assert.equal(s.nativeId,id);assert.equal(s.workspace,f.cwd);assert.equal(s.title,'Grok public session');assert.deepEqual(s.messages,[]);
 const h=await f.adapter.readHistoryDetailed(id);assert.equal(h.complete,true);assert.equal(h.retained,false);assert.deepEqual(h.items.map(x=>[x.role,x.text]),[['user','Grok public NEEDLE_SECRET'],['assistant','Grok answer'],['tool','Safe output']]);assert.doesNotMatch(JSON.stringify([s,h]),/PRIVATE_/);
 for(const [i,p]of [f.path,f.history].entries()){const after=await stat(p);assert.deepEqual(await readFile(p),before[i][0]);assert.equal(after.mtimeMs,before[i][1].mtimeMs);}assert.deepEqual((await readdir(f.directory)).sort(),['chat_history.jsonl','summary.json']);
 await writeFile(f.history,await readFile(f.history,'utf8')+JSON.stringify(user('Grok public NEEDLE_SECRET'))+'\n');const append=await f.adapter.readHistoryDetailed(id);assert.deepEqual(append.items.slice(0,3),h.items);assert.notEqual(append.items.at(-1).id,h.items[0].id);
});
test('Grok root precedence preserves spaces and missing root creates nothing',async t=>{assert.equal(adapters.grokPaths?.({root:'/explicit',env:{GROK_HOME:'/override'}}).root,'/explicit');assert.equal(adapters.grokPaths?.({env:{GROK_HOME:'/path '}}).root,'/path ');assert.equal(adapters.grokPaths?.({home:'/fake',env:{}}).root,'/fake/.grok');const f=await setup(t);const missing=join(f.base,'missing');assert.deepEqual(await new adapters.GrokSessionAdapter({root:missing}).discover(),[]);await assert.rejects(stat(missing));});
for(const suffix of ['{partial',JSON.stringify({type:'future',content:'PRIVATE_UNKNOWN'})+'\n',JSON.stringify({type:'assistant',content:{secret:'PRIVATE_BAD'}})+'\n'])test('Grok incomplete or unsupported selected records fail closed '+suffix.slice(0,20),async t=>{const f=await setup(t);await writeFile(f.history,await readFile(f.history,'utf8')+suffix);const h=await f.adapter.readHistoryDetailed(id);assert.equal(h.complete,false);assert.ok(h.diagnostics.length);assert.doesNotMatch(JSON.stringify(h),/PRIVATE_/);});
test('Grok rejects duplicate UUID, symlinks, unsupported formats/relocation; healthy siblings survive',async t=>{const f=await setup(t);const second='22345678-1234-4234-8234-123456789abc';await fixture(f.root,f.cwd,{nativeId:second});await fixture(f.root,f.cwd,{bucket:'duplicate'});assert.deepEqual((await f.adapter.discover()).map(s=>s.nativeId),[second]);assert.equal((await f.adapter.readHistoryDetailed(id)).complete,false);await rm(join(f.root,'sessions','duplicate'),{recursive:true});await writeFile(f.path,JSON.stringify({...f.metadata,chat_format_version:2}));assert.deepEqual((await f.adapter.discover()).map(s=>s.nativeId),[second]);await writeFile(f.path,JSON.stringify({...f.metadata,cwd_generation:1}));assert.deepEqual((await f.adapter.discover()).map(s=>s.nativeId),[second]);await rm(f.directory,{recursive:true});await symlink(join(f.root,'sessions','opaque-long-path-hash',second),f.directory);assert.deepEqual((await f.adapter.discover()).map(s=>s.nativeId),[second]);});
test('Grok byte/row limits and invalid encoding produce bounded diagnostics without secrets',async t=>{const f=await setup(t);for(const limits of [{maxFileBytes:10},{maxLineBytes:10},{maxItems:2}]){const a=new adapters.GrokSessionAdapter({root:f.root,limits});assert.equal((await a.readHistoryDetailed(id)).complete,false);}await writeFile(f.history,Buffer.from([255,10]));assert.equal((await f.adapter.readHistoryDetailed(id)).complete,false);});
test('Grok capped sibling diagnostics cannot certify an invalid selected record',async t=>{const f=await setup(t);await fixture(f.root,f.cwd,{nativeId:'22345678-1234-4234-8234-123456789abc',summary:{chat_format_version:2}});await writeFile(f.history,await readFile(f.history,'utf8')+JSON.stringify({type:'future',content:'PRIVATE_UNKNOWN'})+'\n');const h=await new adapters.GrokSessionAdapter({root:f.root,limits:{maxDiagnostics:1}}).readHistoryDetailed(id);assert.equal(h.complete,false);assert.equal(h.diagnostics.length,1);assert.doesNotMatch(JSON.stringify(h),/PRIVATE_/);});
test('Grok catalog generation hydrates each discovered history without repeating whole native scans',async t=>{const f=await setup(t);await fixture(f.root,f.cwd,{nativeId:'22345678-1234-4234-8234-123456789abc'});const a=f.adapter;let scans=0;const scan=a.scan.bind(a);a.scan=async()=>{scans++;return scan();};const sessions=await a.discover();for(const session of sessions)assert.equal((await a.readCatalogHistoryDetailed(session.nativeId)).complete,true);assert.equal(scans,1);assert.equal((await a.readHistoryDetailed(id)).complete,true);assert.equal(scans,2,'selected revalidation must freshly establish unique native identity');});
test('Grok catalog retains earlier incomplete cache and refreshes healthy sibling; state aliases cannot overlap native root',async t=>{
 const f=await setup(t);const {NativeCatalog}=await import('../dist/native-catalog.js'),{SearchIndex}=await import('../dist/search-index.js'),{applicationPaths}=await import('../dist/application.js');
 const env={GROK_HOME:f.root,AGENTSWITCH_AGY_ROOT:join(f.base,'agy'),CODEX_HOME:join(f.base,'codex'),CLAUDE_CONFIG_DIR:join(f.base,'claude'),OPENCODE_DB:join(f.base,'missing.db'),XDG_DATA_HOME:join(f.base,'xdg')};const catalog=await NativeCatalog.create(env),index=await SearchIndex.open({directory:join(f.base,'search'),sources:catalog.sources()});t.after(()=>index.close());await catalog.refresh(index);const q={text:'NEEDLE_SECRET',agent:'grok',scope:'folder',workspace:f.cwd};const [hit]=await index.query(q);assert.ok(hit);assert.equal((await catalog.snapshot(hit)).retained,false);
 await writeFile(f.history,await readFile(f.history,'utf8')+'{partial');await fixture(f.root,f.cwd,{nativeId:'22345678-1234-4234-8234-123456789abc',items:[user('Healthy new sibling')]});await catalog.refresh(index);assert.equal((await index.query(q)).length,1);assert.equal((await index.query({...q,text:'Healthy new'})).length,1);assert.equal((await catalog.snapshot(hit)).history.complete,false);
 await assert.rejects(applicationPaths({...env,AGENTSWITCH_STATE_DIR:join(f.root,'app-state')}),/separate/);const alias=join(f.base,'native-alias');await symlink(f.root,alias);await assert.rejects(applicationPaths({...env,AGENTSWITCH_STATE_DIR:join(alias,'new-state')}),/separate/);await assert.rejects(stat(join(f.root,'app-state')));
});
test('Grok restrictive v1 profile omits hidden and synthetic rows, refuses unsupported user attachments and variants',async t=>{
 const f=await setup(t);for(const row of [{type:'user',synthetic_reason:'future_reason',content:[]},{type:'user',prompt_index:1,content:[{type:'image',url:'PRIVATE_ATTACHMENT'}]},{type:'tool_result',tool_call_id:'t',content:'ok',images:'PRIVATE_NOT_A_LIST'}]){await writeFile(f.history,JSON.stringify(row)+'\n');const h=await f.adapter.readHistoryDetailed(id);assert.equal(h.complete,false);assert.doesNotMatch(JSON.stringify(h),/PRIVATE_/);}
 await writeFile(f.path,JSON.stringify({...f.metadata,hidden:true}));assert.deepEqual(await f.adapter.discover(),[]);
});
test('Grok skips backend tool calls and tool_result images silently and keeps the result text',async t=>{
 const f=await setup(t),baseline=await f.adapter.readHistoryDetailed(id),image={type:'image',url:'data:image/png;base64,PRIVATE_IMAGE'};
 const rows=[...f.rows.slice(0,6),{type:'backend_tool_call',id:'b1',name:'PRIVATE_TOOL',arguments:'PRIVATE_ARGS',content:'PRIVATE_RAW'},...f.rows.slice(6),
  {type:'tool_result',tool_call_id:'t2',content:'Screenshot taken',images:[image]},{type:'tool_result',tool_call_id:'t3',content:'',images:[image]}];
 await fixture(f.root,f.cwd,{items:rows});
 const h=await f.adapter.readHistoryDetailed(id);
 assert.deepEqual(h.items.map(x=>[x.role,x.text]),[...baseline.items.map(x=>[x.role,x.text]),['tool','Screenshot taken']]);
 assert.equal(h.complete,true);assert.deepEqual(h.diagnostics,[]);assert.doesNotMatch(JSON.stringify(h),/PRIVATE_/);
});
test('Grok unfinished final line gives exactly one partial-record and is never projected',async t=>{
 const f=await setup(t),text=await readFile(f.history,'utf8'),baseline=await f.adapter.readHistoryDetailed(id);
 for(const tail of ['{"type":"assistant","content":"PRIVATE_UNFINISHED',JSON.stringify({type:'assistant',content:'PRIVATE_NO_NEWLINE'})]){
  await writeFile(f.history,text+tail);const h=await f.adapter.readHistoryDetailed(id);
  assert.equal(h.complete,false);assert.deepEqual(h.diagnostics.map(d=>d.code),['partial-record']);
  assert.deepEqual(h.items,baseline.items);assert.doesNotMatch(JSON.stringify(h),/PRIVATE_/);
 }
});
test('Grok recency compares actual timestamps and title fallback without interpreting bucket names',async t=>{const f=await setup(t),second='22345678-1234-4234-8234-123456789abc';await fixture(f.root,f.cwd,{nativeId:second,summary:{generated_title:null,session_summary:'Fallback public title',last_active_at:'2026-09-29T11:00:00.500Z'}});const sessions=await f.adapter.discover();assert.equal(sessions[0].nativeId,second);assert.equal(sessions[0].title,'Fallback public title');assert.equal(sessions[0].updatedAt,'2026-09-29T11:00:00.500Z');});
test('Grok native subagent sessions are skipped silently; unknown kinds and broken summaries still degrade',async t=>{
 const f=await setup(t),uuid=n=>`${n}2345678-1234-4234-8234-123456789abc`;
 for(const [n,summary] of [[2,{session_kind:'subagent'}],[3,{session_kind:'subagent_fork',parent_session_id:id}],[4,{session_kind:'subagent_resume',chat_format_version:2}],[5,{session_kind:'subagent_future_mode',cwd_generation:1}]])
  await fixture(f.root,f.cwd,{nativeId:uuid(n),summary:{...summary,generated_title:'PRIVATE_SUBAGENT'}});
 const {NativeCatalog}=await import('../dist/native-catalog.js'),{SearchIndex}=await import('../dist/search-index.js');
 const env={GROK_HOME:f.root,AGENTSWITCH_AGY_ROOT:join(f.base,'agy'),CODEX_HOME:join(f.base,'codex'),CLAUDE_CONFIG_DIR:join(f.base,'claude'),OPENCODE_DB:join(f.base,'missing.db'),XDG_DATA_HOME:join(f.base,'xdg')};
 const catalog=await NativeCatalog.create(env),index=await SearchIndex.open({directory:join(f.base,'search'),sources:catalog.sources()});t.after(()=>index.close());
 const diagnostics=[],a=new adapters.GrokSessionAdapter({root:f.root,onDiagnostic:d=>diagnostics.push(d)});
 assert.deepEqual((await a.discover()).map(s=>s.nativeId),[id]);assert.deepEqual(diagnostics,[]);
 await catalog.refresh(index);assert.deepEqual(catalog.notices().filter(n=>n.startsWith('grok:')),[]);
 for(const [n,summary,code] of [[6,{session_kind:'worktree'},'unsupported-shape'],[7,{session_kind:'PRIVATE_FUTURE_KIND'},'unsupported-shape'],[8,{session_kind:'subagent',info:{id:uuid(8),cwd:'relative'}},'malformed-record']]) {
  const extra=await fixture(f.root,f.cwd,{nativeId:uuid(n),summary});diagnostics.length=0;
  assert.deepEqual((await a.discover()).map(s=>s.nativeId),[id]);assert.deepEqual(diagnostics.map(d=>d.code),[code]);
  await catalog.refresh(index);assert.match(catalog.notices().filter(n=>n.startsWith('grok:')).join(' '),new RegExp(code));
  await rm(extra.directory,{recursive:true});
 }
 assert.doesNotMatch(JSON.stringify(catalog.notices()),/PRIVATE_/);
});
