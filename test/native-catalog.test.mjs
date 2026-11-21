import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rename,access,readdir,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeCatalog } from '../dist/native-catalog.js';
import { SearchIndex } from '../dist/search-index.js';
import { applicationPaths } from '../dist/application.js';
import { rollout, writeRollout, completed, ids } from './fixtures/codex/native.mjs';
import { entry,encode,ids as claudeIds } from './fixtures/claude/native.mjs';

const query=cwd=>({text:'',agent:'all',scope:'folder',workspace:cwd});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'agentswitch-catalog-')),cwd=join(root,'workspace'),codex=join(root,'codex'),claude=join(root,'claude');await mkdir(cwd);await mkdir(join(claude,'projects','bucket'),{recursive:true});
 const env={AGENTSWITCH_AGY_ROOT:join(root,'agy'),XDG_DATA_HOME:join(root,'xdg-data'),OPENCODE_DB:join(root,'opencode','opencode.db'),CODEX_HOME:codex,CODEX_SQLITE_HOME:codex,CLAUDE_CONFIG_DIR:claude,AGENTSWITCH_STATE_DIR:join(root,'state')};
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
