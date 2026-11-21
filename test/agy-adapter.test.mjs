import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgySessionAdapter, agyPaths } from '../dist/adapters/index.js';
import { NativeCatalog } from '../dist/native-catalog.js';
import { SearchIndex } from '../dist/search-index.js';
import { applicationPaths } from '../dist/application.js';
const id='12345678-1234-1234-1234-123456789abc';
async function fixture(t) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'agentswitch-agy-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const native=join(root,'native'),cwd=join(root,'workspace with spaces'),other=join(root,'other');
 await Promise.all([join(native,'cache'),cwd,other].map(p=>mkdir(p,{recursive:true})));
 const path=join(native,'cache','last_conversations.json');
 const text=JSON.stringify({[cwd]:id,[other]:'22345678-1234-1234-1234-123456789abc',relative:id,'/bad':{id,secret:'PRIVATE_CREDENTIAL'}});
 await writeFile(path,text);return {root,native,cwd,other,path,text,adapter:new AgySessionAdapter({root:native})};
}
test('agy local cache metadata has exact workspace/ID and unknown date, no invented history/version',async t=>{
 const f=await fixture(t);const sessions=await f.adapter.discover();assert.equal(sessions.length,2);
 const selected=sessions.find(x=>x.nativeId===id);assert.equal(selected.workspace,f.cwd);assert.equal(selected.updatedAt,'');assert.equal(selected.producerVersion,undefined);assert.deepEqual(selected.messages,[]);assert.match(selected.title,/metadata only/);
 const history=await f.adapter.readHistoryDetailed(id);assert.equal(history.complete,false);assert.deepEqual(history.items,[]);assert.equal(history.retained,false);assert.doesNotMatch(JSON.stringify([sessions,history]),/PRIVATE_CREDENTIAL/);assert.equal(await readFile(f.path,'utf8'),f.text);
 assert.deepEqual((await f.adapter.discover()).map(x=>x.id),sessions.map(x=>x.id));
});
test('agy root precedence is explicit root, app override, documented default; no inferred GEMINI_HOME',()=>{
 assert.equal(agyPaths({root:'/explicit',env:{AGENTSWITCH_AGY_ROOT:'/override'}}).root,'/explicit');
 assert.equal(agyPaths({env:{AGENTSWITCH_AGY_ROOT:'/override'}}).root,'/override');
 assert.equal(agyPaths({home:'/synthetic',env:{GEMINI_HOME:'/unproven'}}).root,'/synthetic/.gemini/antigravity-cli');
});
test('agy bounds cache bytes/rows and isolates invalid IDs and ambiguous native IDs',async t=>{
 const f=await fixture(t);const diagnostics=[];const adapter=new AgySessionAdapter({root:f.native,limits:{maxBytes:10},onDiagnostic:d=>diagnostics.push(d)});assert.deepEqual(await adapter.discover(),[]);assert.match(JSON.stringify(diagnostics),/input-limit/);
 await writeFile(f.path,JSON.stringify({[f.cwd]:id,[f.other]:id,'/bad':'--continue','/fine':'32345678-1234-1234-1234-123456789abc'}));
 const entries=await f.adapter.discover();assert.deepEqual(entries.map(x=>x.workspace),['/fine']);
 await writeFile(f.path,'{broken');assert.deepEqual(await f.adapter.discover(),[]);assert.equal((await f.adapter.readHistoryDetailed(id)).complete,false);
});
test('agy cache aliases inside root work, symlink escape and symlink leaf are refused unchanged',async t=>{
 const f=await fixture(t);await symlink(f.native,join(f.root,'alias'));assert.equal((await new AgySessionAdapter({root:join(f.root,'alias')}).discover()).length,2);
 await rm(f.path);const outside=join(f.root,'outside');await writeFile(outside,f.text);await symlink(outside,f.path);assert.deepEqual(await f.adapter.discover(),[]);assert.equal(await readFile(outside,'utf8'),f.text);
 await rm(f.path);await rm(join(f.native,'cache'),{recursive:true});await symlink(f.root,join(f.native,'cache'));await writeFile(join(f.root,'last_conversations.json'),f.text);assert.deepEqual(await f.adapter.discover(),[]);
});
test('agy rejects invalid UTF-8 metadata instead of inventing a replacement-character workspace',async t=>{
 const f=await fixture(t);const bytes=Buffer.concat([Buffer.from('{"'+f.cwd+'/'),Buffer.from([255]),Buffer.from('":"'+id+'"}')]);await writeFile(f.path,bytes);
 assert.deepEqual(await f.adapter.discover(),[]);assert.deepEqual(await readFile(f.path),bytes);
});
test('agy isolates escaped lone surrogates while retaining exact healthy Unicode workspace identities',async t=>{
 const f=await fixture(t),unicode=join(f.other,'📁');await mkdir(unicode);await writeFile(f.path,JSON.stringify({[f.cwd]:id,[f.other+'\ud800']:'22345678-1234-1234-1234-123456789abc',[unicode]:'32345678-1234-1234-1234-123456789abc'}));
 assert.deepEqual(new Set((await f.adapter.discover()).map(x=>x.workspace)),new Set([f.cwd,unicode]));
});
test('agy catalog searches sparse metadata offline, preserves incomplete public-history boundary and rejects state overlap',async t=>{
 const f=await fixture(t);const env={GROK_HOME:join(f.root,'grok'),AGENTSWITCH_AGY_ROOT:f.native,CODEX_HOME:join(f.root,'codex'),CLAUDE_CONFIG_DIR:join(f.root,'claude'),OPENCODE_DB:join(f.root,'opencode.db'),XDG_DATA_HOME:join(f.root,'xdg')};
 const catalog=await NativeCatalog.create(env),index=await SearchIndex.open({directory:join(f.root,'search'),sources:catalog.sources()});t.after(()=>index.close());await catalog.refresh(index);
 const query={text:id,agent:'agy',scope:'folder',workspace:f.cwd};const hits=await index.query(query);assert.equal(hits.length,1);assert.equal(hits[0].updatedAt,'');assert.equal((await index.query({...query,text:'PRIVATE_CREDENTIAL',scope:'global'})).length,0);
 const snapshot=await catalog.snapshot(hits[0]);assert.equal(snapshot.history.complete,false);assert.equal(snapshot.runtime.nativeResume,'compatible');assert.equal(snapshot.retained,false);assert.match(catalog.notices().join(' '),/metadata only/);
 await rename(f.path,f.path+'.missing');await catalog.refresh(index);assert.equal((await index.query(query)).length,1,'unavailable sole metadata store retains the prior searchable generation');await assert.rejects(catalog.snapshot(hits[0]),/unavailable/);await rename(f.path+'.missing',f.path);
 await assert.rejects(applicationPaths({...env,AGENTSWITCH_STATE_DIR:join(f.native,'state')}),/separate/);assert.equal(await readFile(f.path,'utf8'),f.text);
});
