import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rename,access,readdir,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeCatalog, partialHistoryNotice } from '../dist/native-catalog.js';
import { SearchIndex } from '../dist/search-index.js';
import { applicationPaths } from '../dist/application.js';
import { rollout, writeRollout, completed, ids } from './fixtures/codex/native.mjs';
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
 for(const version of ['0.172.0','0.163.0','0.180.0-alpha.2','0.171.0','v0.172']) {
  await writeRollout(f.codex,rollout(f.cwd,ids[0],[completed('UserMessage','u','original public message',1)],{cli_version:version}));await f.catalog.refresh(f.index);
  const codex=await f.catalog.snapshot((await f.index.query({...query(f.cwd),agent:'codex'}))[0]),compatible=version!=='v0.172';
  assert.equal(codex.session.producerVersion,version);assert.equal(codex.runtime.nativeResume,compatible?'compatible':'unknown',version);assert.equal(codex.retained,compatible&&codex.history.retained===true);
 }
 await f.index.close();
});
