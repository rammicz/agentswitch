import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rename,access,readdir,symlink,utimes,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeCatalog, partialHistoryNotice } from '../dist/native-catalog.js';
import { SearchIndex } from '../dist/search-index.js';
import { applicationPaths, searchCacheBytes } from '../dist/application.js';
import { rollout, writeRollout, completed, ids, encode as encodeCodex } from './fixtures/codex/native.mjs';
import { entry,encode,ids as claudeIds } from './fixtures/claude/native.mjs';

const query=cwd=>({text:'',agent:'all',scope:'folder',workspace:cwd});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'agentswitch-catalog-')),cwd=join(root,'workspace'),codex=join(root,'codex'),claude=join(root,'claude');await mkdir(cwd);await mkdir(join(claude,'projects','bucket'),{recursive:true});
 const env={GROK_HOME:join(root,'grok'),AGENTSWITCH_AGY_ROOT:join(root,'agy'),XDG_DATA_HOME:join(root,'xdg-data'),OPENCODE_DB:join(root,'opencode','opencode.db'),CODEX_HOME:codex,CODEX_SQLITE_HOME:codex,CLAUDE_CONFIG_DIR:claude,AGENTSWITCH_STATE_DIR:join(root,'state')};
 const path=await writeRollout(codex,rollout(cwd,ids[0],[completed('UserMessage','u','original public message',1)]));
 const claudePath=join(claude,'projects','bucket',claudeIds[0]+'.jsonl');await writeFile(claudePath,encode([entry(claudeIds[0],cwd,'u',null,'user','healthy sibling')]));
 const catalog=await NativeCatalog.create(env);const index=await SearchIndex.open({directory:join(root,'search'),sources:catalog.sources()});return {root,cwd,codex,claude,env,path,claudePath,catalog,index};
}

test('unavailable/partial source retains earlier index; healthy siblings/new catalog entries remain available',async()=>{
 const f=await fixture();await f.catalog.refresh(f.index);assert.equal((await f.index.query(query(f.cwd))).length,2);
 await rename(f.codex,f.codex+'.missing');await writeFile(f.claudePath,encode([entry(claudeIds[0],f.cwd,'u',null,'user','healthy updated')]));await f.catalog.refresh(f.index);
 assert.equal((await f.index.query({...query(f.cwd),text:'original public'})).length,1);assert.equal((await f.index.query({...query(f.cwd),text:'healthy updated'})).length,1);assert.match(f.catalog.notices().join(' '),/previous search data retained/);
 await rename(f.codex+'.missing',f.codex);await writeFile(f.path,'{broken\n');
 await writeRollout(f.codex,rollout(f.cwd,ids[1],[completed('UserMessage','u','new healthy entry',1)]));await f.catalog.refresh(f.index);
 assert.equal((await f.index.query({...query(f.cwd),text:'new healthy entry'})).length,1);assert.equal((await f.index.query({...query(f.cwd),text:'original public'})).length,1);assert.match(f.catalog.notices().join(' '),/degraded/);
 await f.index.close();
});

test('a re-emitted torn Codex line and an abandoned final line keep the source healthy',async()=>{
 const f=await fixture(),again=completed('AgentMessage','a','re-emitted answer',2),records=rollout(f.cwd,ids[0],[completed('UserMessage','u','original public message',1)]);
 await writeFile(f.path,Buffer.concat([encodeCodex(records),encodeCodex([again]).subarray(0,40),Buffer.from('\n'),encodeCodex([again]),Buffer.from('{"torn":')]));
 const old=new Date(Date.now()-60*60*1000);await utimes(f.path,old,old);
 await f.catalog.refresh(f.index);
 assert.equal((await f.index.query({...query(f.cwd),text:'re-emitted answer'})).length,1);const notice=f.catalog.notices().filter(n=>n.startsWith('codex:')).join(' ');assert.match(notice,/source warnings/);assert.doesNotMatch(notice,/degraded/);
 const codex=(await f.index.query({...query(f.cwd),agent:'codex'}))[0];assert.equal((await f.catalog.snapshot(codex)).history.complete,true);
 await f.index.close();
});

test('selected incomplete source blocks certification; missing Claude producer is accepted by known reader',async()=>{
 const f=await fixture();await f.catalog.refresh(f.index);
 const claude=(await f.index.query({...query(f.cwd),agent:'claude'}))[0];assert.equal((await f.catalog.snapshot(claude)).runtime.nativeResume,'compatible');
 await writeFile(f.path,JSON.stringify(rollout(f.cwd)[0])+'\n{partial');
 const codex=(await f.index.query({...query(f.cwd),agent:'codex'}))[0];assert.equal((await f.catalog.snapshot(codex)).history.complete,false);
 await f.index.close();
});

test('state overlap is rejected before mutation, including aliases and child names beginning with two dots',async()=>{
 const f=await fixture();
 await assert.rejects(applicationPaths({...f.env,AGENTSWITCH_STATE_DIR:join(f.codex,'..local')}),/separate/);assert.equal((await readdir(f.codex)).includes('..local'),false);
 await symlink(f.codex,join(f.root,'alias'));
 await assert.rejects(applicationPaths({...f.env,AGENTSWITCH_STATE_DIR:join(f.root,'alias','new')}),/separate/);assert.equal((await readdir(f.codex)).includes('new'),false);
 await f.index.close();
});

test('catalog refresh scans each provider once while hydrating a larger native generation',async()=>{
 const f=await fixture();
 for(let i=1;i<12;i++)await writeRollout(f.codex,rollout(f.cwd,ids[i],[completed('UserMessage','u',`public ${i}`,1)]));
 let codexScans=0,claudeScans=0;
 const codexScan=f.catalog.adapters.codex.scan.bind(f.catalog.adapters.codex),claudeFiles=f.catalog.adapters.claude.files.bind(f.catalog.adapters.claude);
 f.catalog.adapters.codex.scan=(...args)=>{codexScans++;return codexScan(...args);};f.catalog.adapters.claude.files=(...args)=>{claudeScans++;return claudeFiles(...args);};
 await f.catalog.refresh(f.index);assert.equal((await f.index.query(query(f.cwd))).length,13);assert.equal(codexScans,1);assert.equal(claudeScans,1);
 const selected=(await f.index.query({...query(f.cwd),agent:'codex'}))[0];await f.catalog.snapshot(selected);assert.ok(codexScans>1,'selected source must revalidate actual native discovery');await f.index.close();
});

test('partial-history notice counts blocking selected-history records only and says when more may be unread',()=>{
 const d=(code,source='history')=>({code,source});
 assert.equal(partialHistoryNotice('grok',{complete:true,diagnostics:[d('unsupported-shape')]}),undefined);
 // Grok returns scan-level sibling diagnostics in the same list; OpenCode tolerates an untested producer.
 assert.equal(partialHistoryNotice('grok',{complete:false,diagnostics:[d('unsupported-shape'),d('unsupported-shape'),d('input-limit','root'),d('metadata-schema','metadata')]}),'Partial history: at least 2 source records could not be read (unsupported-shape) and are not included.');
 assert.equal(partialHistoryNotice('opencode',{complete:false,diagnostics:[d('unsupported-shape'),d('untested-producer')]}),'Partial history: at least 1 source record could not be read (unsupported-shape) and is not included.');
 assert.equal(partialHistoryNotice('codex',{complete:false,diagnostics:[d('partial-record'),d('input-limit'),d('diagnostic-limit')]}),'Partial history: at least 2 source records could not be read (partial-record, input-limit, diagnostic-limit) and are not included. Later history may also be unread.');
 // A full list may have been capped without a marker.
 assert.match(partialHistoryNotice('opencode',{complete:false,diagnostics:Array.from({length:100},()=>d('unsupported-shape'))}),/at least 100 source records .* Later history may also be unread\.$/);
 assert.equal(partialHistoryNotice('grok',{complete:false,diagnostics:[d('partial-record')]}),'Partial history: at least 1 source record could not be read (partial-record) and is not included. Later history may also be unread.');
 assert.match(partialHistoryNotice('codex',{complete:false,diagnostics:[...Array.from({length:99},()=>d('unsupported-shape')),d('diagnostic-limit')]}),/at least 99 source records could not be read \(unsupported-shape, diagnostic-limit\) .* Later history may also be unread\.$/);
 assert.equal(partialHistoryNotice('grok',{complete:false,diagnostics:[d('input-limit','root')]}),'Partial history: the source reader reported incomplete history. Unread records are not included.');
});

test('untested Codex and Claude producers stay natively resumable and retained; malformed Codex versions do not',async()=>{
 const f=await fixture();
 await writeFile(f.claudePath,encode([entry(claudeIds[0],f.cwd,'u',null,'user','healthy sibling',{version:'2.1.331'})]));await f.catalog.refresh(f.index);
 const claude=await f.catalog.snapshot((await f.index.query({...query(f.cwd),agent:'claude'}))[0]);assert.equal(claude.session.producerVersion,'2.1.331');assert.equal(claude.runtime.nativeResume,'compatible');
 // The Codex reader flattens a missing, null or non-string cli_version to '', which counts as missing.
 for(const [version,producer,compatible] of [['0.172.0','0.172.0',true],['0.163.0','0.163.0',true],['0.180.0-alpha.2','0.180.0-alpha.2',true],['0.171.0','0.171.0',true],[undefined,'',true],[null,'',true],['','',true],[0.172,'',true],['v0.172','v0.172',false],['garbage','garbage',false]]) {
  await writeRollout(f.codex,rollout(f.cwd,ids[0],[completed('UserMessage','u','original public message',1)],{cli_version:version}));await f.catalog.refresh(f.index);
  const codex=await f.catalog.snapshot((await f.index.query({...query(f.cwd),agent:'codex'}))[0]);
  assert.equal(codex.session.producerVersion,producer);assert.equal(codex.runtime.nativeResume,compatible?'compatible':'unknown',String(version));assert.equal(codex.retained,compatible&&codex.history.retained===true);
 }
 await f.index.close();
});

test('T3: a clean discovery prunes cached sessions whose native history is gone; a degraded one keeps them',async()=>{
 const f=await fixture();
 const second=await writeRollout(f.codex,rollout(f.cwd,ids[1],[completed('UserMessage','u','second public message',1)]));
 await writeFile(f.claudePath,encode([entry(claudeIds[0],f.cwd,'u',null,'user','public sibling')]));
 const cache=async()=>f.index;
 const search=async(text,catalog)=>{const controller=new AbortController();return catalog.search({...query(f.cwd),text},controller.signal,controller.signal,()=>{},cache);};
 const cached=async()=>(await f.index.query({...query(f.cwd),agent:'all'})).map(hit=>hit.id).sort();
 assert.equal((await search('public',f.catalog)).length,3);
 assert.deepEqual(await cached(),[`claude:${claudeIds[0]}`,`codex:${ids[0]}`,`codex:${ids[1]}`]);
 // Missing managed root: unavailable, not deleted. Nothing is pruned.
 await rename(f.codex,f.codex+'.missing');
 await search('',await NativeCatalog.create(f.env));
 assert.equal((await cached()).length,3);
 await rename(f.codex+'.missing',f.codex);
 // A discovery that reports a blocking diagnostic is degraded. Nothing is pruned.
 await rm(second);
 const broken=join(f.codex,'sessions','2026','11','20','rollout-2026-11-20T10-00-00-'+ids[2]+'.jsonl');await writeFile(broken,'{broken\n');
 const degraded=await NativeCatalog.create(f.env);await search('',degraded);
 assert.match(degraded.notices().join(' '),/codex: source warnings/);
 assert.equal((await cached()).length,3);
 await rm(broken);
 await search('',await NativeCatalog.create(f.env));
 assert.deepEqual(await cached(),[`claude:${claudeIds[0]}`,`codex:${ids[0]}`]);
 // Without an existing cache, a search never creates one just to prune it.
 const catalog=await NativeCatalog.create(f.env),controller=new AbortController();
 const requested=[];await catalog.search(query(f.cwd),controller.signal,controller.signal,()=>{},async create=>{requested.push(create);});
 assert.ok(requested.length&&requested.every(create=>create===false));
 await f.index.close();
});

test('T2: AGENTSWITCH_SEARCH_CACHE_MIB lowers the 256 MiB search cache cap and never raises it',()=>{
 assert.equal(searchCacheBytes({}),256*2**20);
 assert.equal(searchCacheBytes({AGENTSWITCH_SEARCH_CACHE_MIB:' 64 '}),64*2**20);
 assert.equal(searchCacheBytes({AGENTSWITCH_SEARCH_CACHE_MIB:'256'}),256*2**20);
 for(const value of ['0','257','1.5','-1','64MiB','1e2'])assert.throws(()=>searchCacheBytes({AGENTSWITCH_SEARCH_CACHE_MIB:value}),/whole number of MiB from 1 to 256/);
});
