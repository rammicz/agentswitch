import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,readdir,writeFile,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture,id } from './fixtures/opencode/native.mjs';

test('1.19.6 discovers lazy metadata and ordered public projection without native changes or credential content',async()=>{
 const {OpenCodeSessionAdapter}=await import('../dist/adapters/opencode.js');
 const root=await mkdtemp(join(tmpdir(),'agentswitch-opencode-'));const path=await fixture(join(root,'opencode.db'),root);const before=await readFile(path),files=await readdir(root);
 const adapter=new OpenCodeSessionAdapter({dbPath:path});const sessions=await adapter.discover();
 assert.equal(sessions.length,1);assert.equal(sessions[0].nativeId,id);assert.equal(sessions[0].workspace,await realpath(root));assert.equal(sessions[0].producerVersion,'1.19.6');assert.deepEqual(sessions[0].messages,[]);
 const history=await adapter.readHistoryDetailed(id);assert.equal(history.complete,true);assert.deepEqual(history.items.map(x=>[x.role,x.text,x.status]),[['user','First public','complete'],['user','OpenCode public NEEDLE_SECRET','complete'],['tool','Safe output','complete'],['tool','Safe error','failed'],['assistant','OpenCode answer','complete']]);assert.equal(new Set(history.items.map(x=>x.id)).size,5);assert.doesNotMatch(JSON.stringify(history),/PRIVATE_/);
 assert.deepEqual(await readFile(path),before);assert.deepEqual(await readdir(root),files);
 await writeFile(path+'-wal','synthetic active WAL');assert.deepEqual(await adapter.discover(),[]);assert.equal((await adapter.readHistoryDetailed(id)).complete,false);
});

import { DatabaseSync } from 'node:sqlite';
import { mkdir,symlink,unlink,rename } from 'node:fs/promises';
import { OpenCodeSessionAdapter,openCodePaths } from '../dist/adapters/opencode.js';
import { NativeCatalog } from '../dist/native-catalog.js';
import { SearchIndex } from '../dist/search-index.js';
import { applicationPaths } from '../dist/application.js';
async function setup(){const root=await mkdtemp(join(tmpdir(),'agentswitch-opencode-'));const cwd=join(root,'workspace');await mkdir(cwd);const path=await fixture(join(root,'native','opencode.db'),cwd);return {root,cwd,path};}
function mutate(path,fn){const db=new DatabaseSync(path);try{fn(db);}finally{db.close();}}

test('native DB/root precedence is explicit and follows the 1.19.6 truthy XDG and OPENCODE_DB contract',()=>{
 const home='/synthetic/home';
 assert.deepEqual(openCodePaths({home,env:{}}),{root:home+'/.local/share/opencode',dbPath:home+'/.local/share/opencode/opencode.db'});
 assert.equal(openCodePaths({home,env:{XDG_DATA_HOME:'/data',OPENCODE_DB:'chosen.db',OPENCODE_CONFIG_DIR:'/wrong'}}).dbPath,'/data/opencode/chosen.db');
 assert.equal(openCodePaths({home,env:{XDG_DATA_HOME:'',OPENCODE_DB:''}}).dbPath,home+'/.local/share/opencode/opencode.db');
 assert.equal(openCodePaths({dbPath:'/override',env:{OPENCODE_DB:'/ignored'}}).dbPath,'/override');
 assert.equal(openCodePaths({env:{OPENCODE_DB:':memory:'}}).dbPath,':memory:');
});
for(const sidecar of ['-wal','-shm','-journal','-mj123'])test(`quiescent reader refuses ${sidecar} without changing native files`,async()=>{
 const f=await setup();await writeFile(f.path+sidecar,'synthetic');const before=await readFile(f.path);const diagnostics=[];const adapter=new OpenCodeSessionAdapter({dbPath:f.path,onDiagnostic:x=>diagnostics.push(x)});
 assert.deepEqual(await adapter.discover(),[]);assert.ok(diagnostics.some(x=>x.code==='unsupported-mode'));assert.deepEqual(await readFile(f.path),before);assert.equal((await readFile(f.path+sidecar,'utf8')),'synthetic');
});
test('unsupported v2 schema, nonlocal/child/archived sessions and producer versions fail closed',async()=>{
 const f=await setup();const adapter=new OpenCodeSessionAdapter({dbPath:f.path});
 for(const [field,value]of [['workspace_id','wrk_remote'],['parent_id','ses_parent'],['time_archived',12],['version','2.3.2']]){mutate(f.path,db=>db.prepare(`UPDATE session SET ${field}=?`).run(value));assert.deepEqual(await adapter.discover(),[]);mutate(f.path,db=>db.prepare(`UPDATE session SET ${field}=?`).run(field==='version'?'1.19.6':null));}
 mutate(f.path,db=>db.exec('DROP TABLE message'));assert.deepEqual(await adapter.discover(),[]);
});
test('revert message and part boundaries omit the undone tail; an invalid boundary blocks history',async()=>{
 for(const [revert,expected]of [[{messageID:'msg_b'},['First public','OpenCode public NEEDLE_SECRET']],[{messageID:'msg_b',partID:'prt_h'},['First public','OpenCode public NEEDLE_SECRET','Safe output']],[{messageID:'msg_missing'},[]]]){
  const f=await setup();mutate(f.path,db=>db.prepare('UPDATE session SET revert=?').run(JSON.stringify(revert)));const history=await new OpenCodeSessionAdapter({dbPath:f.path}).readHistoryDetailed(id);assert.deepEqual(history.items.map(x=>x.text),expected);assert.equal(history.complete,expected.length>0);
 }
});
test('malformed sibling sessions/parts isolate diagnostics and prohibit structured output, running tools and reasoning',async()=>{
 const f=await setup();mutate(f.path,db=>{
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?)').run('invalid',f.cwd,null,null,'bad','1.19.6',1,2,null,null);
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_bad','msg_b',id,1,1,'{malformed');
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_struct','msg_b',id,1,1,JSON.stringify({type:'text',text:{private:'PRIVATE_STRUCTURED'}}));
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_running','msg_b',id,1,1,JSON.stringify({type:'tool',state:{status:'running',output:'PRIVATE_RUNNING'}}));
 });const diagnostics=[];const adapter=new OpenCodeSessionAdapter({dbPath:f.path,onDiagnostic:d=>diagnostics.push(d)});assert.equal((await adapter.discover()).length,1);
 const history=await adapter.readHistoryDetailed(id);assert.equal(history.complete,false);assert.equal(history.items.length,5);assert.doesNotMatch(JSON.stringify(history),/PRIVATE_/);assert.ok(diagnostics.some(x=>x.code==='malformed-record'));
});
test('row/database/text limits are bounded, and leaf symlinks are refused',async()=>{
 const f=await setup();for(const limits of [{maxRows:2},{maxTextBytes:5},{maxDatabaseBytes:100}]){const adapter=new OpenCodeSessionAdapter({dbPath:f.path,limits});const history=await adapter.readHistoryDetailed(id);assert.equal(history.complete,false);assert.deepEqual(history.items,[]);}
 const alias=join(f.root,'alias');await symlink(f.path,alias);assert.deepEqual(await new OpenCodeSessionAdapter({dbPath:alias}).discover(),[]);
});
test('pre/post path, identity and sidecar races reject the entire projection without recovery or copies',async()=>{
 for(const change of ['sidecar','replace']){
  const f=await setup();const adapter=new OpenCodeSessionAdapter({dbPath:f.path});const physical=adapter.physical.bind(adapter);let count=0;
  adapter.physical=async()=>{const state=await physical();if(++count===1){if(change==='sidecar')await writeFile(f.path+'-wal','raced');else {await rename(f.path,f.path+'.original');await fixture(f.path,f.cwd);}}return state;};
  assert.deepEqual(await adapter.discover(),[]);assert.equal((await readdir(join(f.root,'native'))).some(name=>name.includes('snapshot')),false);
 }
});
test('catalog preserves cached public history on WAL, replacement or unsupported schema and keys configured roots',async()=>{
 const f=await setup();const env={GROK_HOME:join(f.root,'grok'),AGENTSWITCH_AGY_ROOT:join(f.root,'agy'),OPENCODE_DB:f.path,XDG_DATA_HOME:join(f.root,'xdg'),CODEX_HOME:join(f.root,'codex'),CLAUDE_CONFIG_DIR:join(f.root,'claude')};const catalog=await NativeCatalog.create(env);const index=await SearchIndex.open({directory:join(f.root,'cache'),sources:catalog.sources()});const query={text:'Safe output',scope:'folder',workspace:f.cwd,agent:'opencode'};
 await catalog.refresh(index);assert.equal((await index.query(query)).length,1);const key=catalog.rootKey('opencode');assert.notEqual((await NativeCatalog.create({...env,OPENCODE_DB:join(f.root,'other.db')})).rootKey('opencode'),key);
 await writeFile(f.path+'-wal','active');await catalog.refresh(index);assert.equal((await index.query(query)).length,1);assert.match(catalog.notices().join(' '),/opencode: degraded/);await unlink(f.path+'-wal');
 mutate(f.path,db=>db.exec("UPDATE session SET version='2.3.2'"));await catalog.refresh(index);assert.equal((await index.query(query)).length,1);
 mutate(f.path,db=>db.exec('DROP TABLE part'));await catalog.refresh(index);assert.equal((await index.query(query)).length,1);await index.close();
});
test('state overlap with OpenCode native roots, exact database or sidecars rejects before writes, including aliases',async()=>{
 const f=await setup();const env={GROK_HOME:join(f.root,'grok'),AGENTSWITCH_AGY_ROOT:join(f.root,'agy'),XDG_DATA_HOME:join(f.root,'data'),OPENCODE_DB:f.path,CODEX_HOME:join(f.root,'codex'),CLAUDE_CONFIG_DIR:join(f.root,'claude')};
 for(const state of [f.path,f.path+'-wal',f.path+'-shm',f.path+'-journal',f.path+'-mj123',join(f.root,'data','opencode','application')]){await assert.rejects(applicationPaths({...env,AGENTSWITCH_STATE_DIR:state}),/separate/);if(state!==f.path)await assert.rejects(lstat(state));}
 const alias=join(f.root,'native-alias');await symlink(f.path,alias);await assert.rejects(applicationPaths({...env,AGENTSWITCH_STATE_DIR:alias}),/separate/);
 await writeFile(f.path+'-wal','synthetic sidecar');const sidecarAlias=join(f.root,'sidecar-alias');await symlink(f.path+'-wal',sidecarAlias);await assert.rejects(applicationPaths({...env,AGENTSWITCH_STATE_DIR:sidecarAlias}),/separate/);
});
import { lstat } from 'node:fs/promises';
test('immutable URI preserves literal encoded path characters and exact repeated stable item IDs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentswitch-opencode-uri-'));const path=await fixture(join(root,"data %?#' space",'opencode.db'),root);const adapter=new OpenCodeSessionAdapter({dbPath:path});const first=await adapter.readHistoryDetailed(id),second=await adapter.readHistoryDetailed(id);assert.equal(first.complete,true);assert.deepEqual(first.items,second.items);assert.equal(first.incarnation,second.incarnation);
});
test('an incomplete or failed assistant remains distinguishable from completed public output',async()=>{
 const f=await setup();for(const [data,expected]of [[{role:'assistant',time:{created:2}},'interrupted'],[{role:'assistant',time:{created:2,completed:3},error:{name:'synthetic'}},'failed'],[{role:'assistant',time:{created:2,completed:'invalid'}},'interrupted']]){mutate(f.path,db=>db.prepare('UPDATE message SET data=? WHERE id=?').run(JSON.stringify(data),'msg_b'));const history=await new OpenCodeSessionAdapter({dbPath:f.path}).readHistoryDetailed(id);assert.equal(history.items.at(-1).status,expected);}
});
test('a reverted message with no parts still excludes all following messages, and empty part boundaries are invalid',async()=>{
 const f=await setup();mutate(f.path,db=>{
  db.exec("DELETE FROM part WHERE message_id='msg_b'");db.prepare('UPDATE session SET revert=?').run(JSON.stringify({messageID:'msg_b'}));
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('msg_c',id,3,3,JSON.stringify({role:'user',time:{created:3}}));db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_tail','msg_c',id,3,3,JSON.stringify({type:'text',text:'PRIVATE_UNDONE'}));
 });const adapter=new OpenCodeSessionAdapter({dbPath:f.path});const history=await adapter.readHistoryDetailed(id);assert.equal(history.complete,true);assert.deepEqual(history.items.map(x=>x.text),['First public','OpenCode public NEEDLE_SECRET']);
 mutate(f.path,db=>db.prepare('UPDATE session SET revert=?').run(JSON.stringify({messageID:'msg_a',partID:''})));assert.equal((await adapter.readHistoryDetailed(id)).complete,false);
});
test('an external OpenCode DB may share a home/parent ancestor with separate application state',async()=>{
 const f=await setup();const env={GROK_HOME:join(f.root,'grok'),AGENTSWITCH_AGY_ROOT:join(f.root,'agy'),XDG_DATA_HOME:join(f.root,'data'),XDG_CONFIG_HOME:join(f.root,'config'),XDG_CACHE_HOME:join(f.root,'cache'),XDG_STATE_HOME:join(f.root,'state'),OPENCODE_DB:join(f.root,'opencode.db'),CODEX_HOME:join(f.root,'codex'),CLAUDE_CONFIG_DIR:join(f.root,'claude')};await fixture(env.OPENCODE_DB,f.cwd);
 const paths=await applicationPaths({...env,AGENTSWITCH_STATE_DIR:join(f.root,'.local','state','agentswitch')});assert.equal(paths.root,await realpath(join(f.root,'.local','state','agentswitch')));assert.equal((await new OpenCodeSessionAdapter({env}).discover()).length,1);
 for(const native of [join(env.XDG_DATA_HOME,'opencode'),join(env.XDG_CONFIG_HOME,'opencode'),join(env.XDG_CACHE_HOME,'opencode'),join(env.XDG_STATE_HOME,'opencode')])await assert.rejects(applicationPaths({...env,AGENTSWITCH_STATE_DIR:join(native,'child')}),/separate/);
});
test('a v2-style part ordinal/foreign schema is not accepted as the exact 1.19.6 projection',async()=>{
 const f=await setup();mutate(f.path,db=>db.exec('ALTER TABLE part ADD COLUMN ordinal INTEGER'));const diagnostics=[];assert.deepEqual(await new OpenCodeSessionAdapter({dbPath:f.path,onDiagnostic:x=>diagnostics.push(x)}).discover(),[]);assert.ok(diagnostics.some(x=>x.code==='unsupported-shape'));
});
test('unknown or malformed selected part types and tool states cannot certify complete history',async()=>{
 for(const data of [{type:'future-public-shape',text:'UNCLASSIFIED_PUBLIC_TEXT'}, {type:'future-public-shape',synthetic:true,ignored:true,text:'UNCLASSIFIED_PUBLIC_TEXT'}, {type:null,text:'UNCLASSIFIED_PUBLIC_TEXT'}, {text:'UNCLASSIFIED_PUBLIC_TEXT'}, {type:42,text:'UNCLASSIFIED_PUBLIC_TEXT'}, {type:{nested:'future'},text:'UNCLASSIFIED_PUBLIC_TEXT'}, {type:'tool',state:{status:'future-state',output:'UNCLASSIFIED_PUBLIC_TEXT'}}, {type:'tool',ignored:true,state:{status:'future-state',output:'UNCLASSIFIED_PUBLIC_TEXT'}}, {type:'tool',state:null}, {type:'tool',state:{status:42}}, {type:'tool',state:{status:{future:true}}}]) {
  const f=await setup();mutate(f.path,db=>db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_unknown','msg_b',id,3,3,JSON.stringify(data)));
  const history=await new OpenCodeSessionAdapter({dbPath:f.path}).readHistoryDetailed(id);
  assert.equal(history.complete,false,'unsupported selected shape must block completeness: '+JSON.stringify(data));assert.ok(history.diagnostics.some(d=>d.code==='unsupported-shape'));assert.equal(history.items.length,5);assert.doesNotMatch(JSON.stringify(history),/UNCLASSIFIED_PUBLIC_TEXT/);
 }
});
test('every intentionally excluded pinned 1.19.6 part kind and unsettled tool state preserves known public completeness',async()=>{
 const f=await setup();mutate(f.path,db=>{
  const parts=[
   ...['subtask','reasoning','file','step-start','step-finish','snapshot','patch','agent','retry','compaction'].map(type=>({type,text:'PRIVATE_EXCLUDED_PAYLOAD'})),
   {type:'text',synthetic:true,text:'PRIVATE_EXCLUDED_PAYLOAD'}, {type:'text',ignored:true,text:'PRIVATE_EXCLUDED_PAYLOAD'},
   ...['pending','running'].map(status=>({type:'tool',state:{status,output:'PRIVATE_EXCLUDED_PAYLOAD'}})),
  ];
  parts.forEach((data,index)=>db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_excluded'+index,'msg_b',id,3,3,JSON.stringify(data)));
 });const history=await new OpenCodeSessionAdapter({dbPath:f.path}).readHistoryDetailed(id);assert.equal(history.complete,true);assert.deepEqual(history.diagnostics,[]);assert.equal(history.items.length,5);assert.doesNotMatch(JSON.stringify(history),/PRIVATE_/);
});
test('unknown selected shape retains its prior cache while healthy OpenCode sibling history refreshes',async()=>{
 const f=await setup();mutate(f.path,db=>{
  db.prepare('INSERT INTO session SELECT ?,directory,workspace_id,parent_id,?,version,time_created,time_updated,time_archived,revert FROM session WHERE id=?').run('ses_healthy','Healthy OpenCode',id);
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('msg_healthy','ses_healthy',3,3,JSON.stringify({role:'user',time:{created:3}}));db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_healthy','msg_healthy','ses_healthy',3,3,JSON.stringify({type:'text',text:'healthy original'}));
 });const env={GROK_HOME:join(f.root,'grok'),AGENTSWITCH_AGY_ROOT:join(f.root,'agy'),OPENCODE_DB:f.path,XDG_DATA_HOME:join(f.root,'data'),CODEX_HOME:join(f.root,'codex'),CLAUDE_CONFIG_DIR:join(f.root,'claude')};const catalog=await NativeCatalog.create(env);const index=await SearchIndex.open({directory:join(f.root,'cache'),sources:catalog.sources()});const query={text:'',agent:'opencode',scope:'folder',workspace:f.cwd};
 try {
  await catalog.refresh(index);assert.equal((await index.query(query)).length,2);
  mutate(f.path,db=>{db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_unknown','msg_b',id,3,3,JSON.stringify({type:'future-public-shape',text:'UNCLASSIFIED_PUBLIC_TEXT'}));db.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify({type:'text',text:'healthy updated'}),'prt_healthy');});
  await catalog.refresh(index);assert.equal((await index.query({...query,text:'OpenCode public'})).length,1);assert.equal((await index.query({...query,text:'healthy updated'})).length,1);assert.equal((await index.query({...query,text:'UNCLASSIFIED_PUBLIC_TEXT'})).length,0);assert.match(catalog.notices().join(' '),/opencode: degraded.*unsupported-shape/);const selected=(await index.query({...query,text:'OpenCode public'}))[0];assert.equal((await catalog.snapshot(selected)).history.complete,false);
 }finally{await index.close();}
});
