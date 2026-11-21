import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { rollout, writeRollout, completed, ids } from './fixtures/codex/native.mjs';
import { TransferJournal } from '../dist/transfer-journal.js';
const repo=resolve('.');
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
async function setup(mode='valid') {
 const root=await mkdtemp(join(tmpdir(),"agentswitch continuity ' quoted ")),cwd=join(root,'workspace'),codex=join(root,'codex'),claude=join(root,'claude'),state=join(root,'state'),bin=join(root,'bin');
 await Promise.all([cwd,claude,bin].map(path=>mkdir(path,{recursive:true})));
 const aFile=await writeRollout(codex,rollout(cwd,ids[0],[completed('UserMessage','a1','A original request',1),completed('AgentMessage','a2','A original answer',2)]));
 const config=join(codex,'config.toml');await writeFile(config,'# Synthetic existing callbacks and native policy must stay unchanged.\n[hooks]\nStop = [{hooks=[{type="command",command="synthetic-existing-callback"}]}]\n');
 for(const provider of ['codex','claude'])await writeFile(join(bin,provider),`#!${process.execPath}\nprocess.env.FAKE_PROVIDER=${JSON.stringify(provider)};await import(${JSON.stringify(join(repo,'test/fixtures/continuity-provider.mjs'))});\n`,{mode:0o700});
 return {root,cwd,state,codex,claude,aFile,config,configHash:await hash(config),env:{GROK_HOME:join(root,'grok'),AGENTSWITCH_AGY_ROOT:join(root,'agy'),XDG_DATA_HOME:join(root,'xdg-data'),OPENCODE_DB:join(root,'opencode','opencode.db'),CODEX_HOME:codex,CODEX_SQLITE_HOME:codex,CLAUDE_CONFIG_DIR:claude,AGENTSWITCH_STATE_DIR:state,PATH:bin+':'+process.env.PATH,RUNTIME_LOG:join(root,'launches'),HOOK_LOG:join(root,'hooks'),FAKE_HOOK_MODE:mode,AGENTSWITCH_OBSERVER:'inherited-unrelated-locator-must-be-scrubbed',...(process.env.AGENTSWITCH_TEST_ENTRY?{CLI_ENTRY_MODULE:process.env.AGENTSWITCH_TEST_ENTRY}:{})}};
}
function pty(f,actions) {
 const result=spawnSync('python3',['test/fixtures/drive-integration.py'],{encoding:'utf8',input:JSON.stringify({node:process.execPath,runner:join(repo,'test/fixtures/integration-runner.mjs'),cwd:f.cwd,env:f.env,actions}),timeout:40000,maxBuffer:8*1024*1024});
 assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout)[0];
}
const select=(text)=>[{wait:'Enter preview'},{send:text},{wait:'Enter preview'},{send:'\r'},{wait:'Enter choose target'},{send:'\r'},{wait:'C edit request'}];
const confirm=[{send:'\r'},{wait:'Exact initial user prompt'},{send:'\r'},{wait:'READY'},{send:'quit\n'}];
async function record(f) {const journal=await TransferJournal.open(join(f.state,'transfers'));try{return journal.list();}finally{journal.close();}}
async function switchToB(f) {
 const before=await hash(f.aFile);const result=pty(f,[...select('A original'),{send:'\u001b[C'},{wait:'Target: claude'},...confirm,{wait:'uncertain — process exited'}]);
 assert.equal(result.restored,true);assert.equal(await hash(f.aFile),before);
 const [launch]= (await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(launch.locator,false);
 return launch;
}
test('default CLI A→B→A resumes actual A, aliases echo, sends missing IDs only and atomically accepts a real-shaped successful main turn',async()=>{
 const f=await setup();const bLaunch=await switchToB(f),bBefore=await hash(bLaunch.path);
 const [first]=await record(f);const originalIds=first.includedItemIds;
 const result=pty(f,[...select('B response'),{send:'\r'},{wait:'Actual resumed target: codex '+ids[0]},{send:'\r'},{wait:'READY'},{send:'quit\n'},{wait:'accepted — correlated native turn'}]);
 assert.equal(result.code,0);assert.equal(result.restored,true);assert.equal(await hash(bLaunch.path),bBefore);
 assert.equal(await hash(f.config),f.configHash);
 const launches=(await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n').map(JSON.parse),aLaunch=launches[1];
 assert.equal(aLaunch.args[0],'resume');assert.equal(aLaunch.args.at(-2),ids[0]);assert.deepEqual(aLaunch.tty,[true,true,true]);
 const payload=JSON.parse(aLaunch.args.at(-1));assert.deepEqual(payload.history.map(item=>item.text),['Continue the task from this conversation.','B response']);
 assert.ok(payload.history.every(item=>!originalIds.includes(item.id)));assert.equal(payload.currentRequest,'Continue the task from this conversation.');
 assert.ok(Buffer.byteLength(aLaunch.args.at(-1))<=16384);assert.ok(aLaunch.args.filter(arg=>arg.startsWith('hooks.')).length===2);
 assert.ok(!aLaunch.args.some(arg=>/trust|approval|sandbox|enable|notify/.test(arg)));
 const [accepted]=await record(f);assert.equal(accepted.state,'accepted');assert.equal(accepted.targetNativeId,ids[0]);assert.equal(accepted.writer,'stopped');
 const journal=await TransferJournal.open(join(f.state,'transfers'));const a=journal.contexts().find(context=>context.ref.nativeId===ids[0]);assert.deepEqual(new Set(a.coveredIds),new Set([...payload.history.map(item=>item.id),accepted.continuity.requestId]));journal.close();
 const hooks=(await readFile(f.env.HOOK_LOG,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(hooks.length,3);assert.equal(new Set(hooks.map(hook=>hook.command)).size,1);for(const hook of hooks){assert.equal(hook.status,0);assert.equal(hook.stdout,'');assert.equal(hook.stderr,'');assert.ok(!hook.command.includes(accepted.id));const helper=process.env.AGENTSWITCH_TEST_ENTRY?process.env.AGENTSWITCH_TEST_ENTRY.replace(/cli\.js$/,'native-observer.js'):resolve('dist/native-observer.js');assert.ok(hook.command.includes(helper.replaceAll("'","'\\''")));}
});
test('default CLI A→B→A repeated returns reuse accepted A and evolve only the exact missing set',async()=>{
 const f=await setup();const b=await switchToB(f);
 for(let turn=0;turn<2;turn++) {
  const result=pty(f,[...select('B response'),...confirm,{wait:'accepted — correlated native turn'}]);assert.equal(result.code,0);
  const launch=(await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(launch.args[0],'resume','An accepted native turn must remain reusable on the next return');assert.equal(launch.args.at(-2),ids[0]);
  assert.deepEqual(JSON.parse(launch.args.at(-1)).history.map(item=>item.text),turn===0?['Continue the task from this conversation.','B response']:[]);
 }
 const entries=(await readFile(b.path,'utf8')).trim().split('\n').map(JSON.parse),base=entries.at(-1);
 for(const [uuid,parentUuid,type,content]of [['b-next','b-answer','user','B incremental request'],['b-next-answer','b-next','assistant','B incremental answer']])entries.push({...base,uuid,parentUuid,type,message:{id:'response-'+uuid,role:type,content}});
 await writeFile(b.path,entries.map(JSON.stringify).join('\n')+'\n');
 pty(f,[...select('B incremental'),...confirm,{wait:'accepted — correlated native turn'}]);
 const launches=(await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n').map(JSON.parse),last=launches.at(-1);assert.equal(last.args[0],'resume');assert.equal(last.args.at(-2),ids[0]);
 const payload=JSON.parse(last.args.at(-1));assert.deepEqual(payload.history.map(item=>item.text),['B incremental request','B incremental answer']);
 const records=await record(f),priorIds=new Set(records[1].includedItemIds);assert.ok(payload.history.every(item=>!priorIds.has(item.id)));assert.equal(new Set(records.slice(0,3).map(record=>record.targetNativeId)).size,1);
});
for(const mode of ['unrelated-output','missing-item-turn','intervening-user'])test(`accepted receipt with ${mode} does not certify appended native branch or reuse it`,async()=>{
 const f=await setup(mode);await switchToB(f);
 pty(f,[...select('B response'),...confirm,{wait:'accepted — correlated native turn'}]);const [accepted]=await record(f);assert.equal(accepted.state,'accepted');assert.equal(accepted.branchCheckpoint,undefined);
 pty(f,[...select('B response'),...confirm,{wait:'accepted — correlated native turn'}]);const launch=(await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n').map(JSON.parse).at(-1);assert.ok(!launch.args.includes('resume'));
});
test('independent growth after a certified accepted turn falls fresh while preserving its known own output',async()=>{
 const f=await setup();await switchToB(f);pty(f,[...select('B response'),...confirm,{wait:'accepted — correlated native turn'}]);assert.ok((await record(f))[0].branchCheckpoint);
 const ordinal=(await readFile(f.aFile,'utf8')).trim().split('\n').length;await appendFile(f.aFile,JSON.stringify(completed('UserMessage','external-after-accepted','Independent native continuation',ordinal))+'\n');
 pty(f,[...select('B response'),...confirm,{wait:'accepted — correlated native turn'}]);const launch=(await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n').map(JSON.parse).at(-1);assert.ok(!launch.args.includes('resume'));
 const texts=JSON.parse(launch.args.at(-1)).history.map(item=>item.text);assert.ok(texts.includes('A response'));assert.ok(!texts.includes('Independent native continuation'));
});
for(const change of ['growth','replacement','root'])test(`default CLI ${change} of earlier target uses reviewed fresh rebuild`,async()=>{
 const f=await setup();await switchToB(f);
 if(change==='growth')await appendFile(f.aFile,JSON.stringify(completed('UserMessage','external','Independent A continuation',3))+'\n');
 if(change==='replacement'){await rename(f.aFile,f.aFile+'.retired');await writeFile(f.aFile,await readFile(f.aFile+'.retired'));await rm(f.aFile+'.retired');}
 if(change==='root'){const root=join(f.root,'other codex');await mkdir(root);f.env.CODEX_HOME=root;f.env.CODEX_SQLITE_HOME=root;}
 const result=pty(f,[...select('B response'),...confirm,{wait:'accepted — correlated native turn'}]);
 const launch=(await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n').map(JSON.parse).at(-1);assert.ok(!launch.args.includes('resume'));assert.match(result.output,/fresh bounded rebuild/);
 const payload=JSON.parse(launch.args.at(-1));assert.deepEqual(payload.history.map(item=>item.text),['A original request','A original answer','Continue the task from this conversation.','B response']);
});
test('explicit F recovers active source after direct archive deletion without importing unavailable ancestry',async()=>{
 const f=await setup();await switchToB(f);const [first]=await record(f);
 await rm(join(first.archive.directory,first.archive.id+'.json'));
 const result=pty(f,[...select('B response'),{send:'f'},{wait:'Fresh context: explicitly selected'},...confirm,{wait:'accepted — correlated native turn'}]);
 assert.equal(result.code,0);const launch=(await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n').map(JSON.parse).at(-1);assert.ok(!launch.args.includes('resume'));
 assert.deepEqual(JSON.parse(launch.args.at(-1)).history.map(item=>item.text),['A original request','A original answer','Continue the task from this conversation.','B response']);
});
test('rollback invalidates the causal suffix and does not reuse A that already retained the removed B response',async()=>{
 const f=await setup();const b=await switchToB(f);const [first]=await record(f);
 pty(f,[...select('B response'),...confirm,{wait:'accepted — correlated native turn'}]);
 const lines=(await readFile(b.path,'utf8')).trim().split('\n');await writeFile(b.path,lines[0]+'\n');
 const result=pty(f,[...select(first.archive.id),...confirm,{wait:'accepted — correlated native turn'}]);
 const launch=(await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n').map(JSON.parse).at(-1);assert.ok(!launch.args.includes('resume'));assert.match(result.output,/removed or changed activity/);
 const payload=JSON.parse(launch.args.at(-1));assert.ok(!payload.history.some(item=>item.text==='B response'));
 const [last,prior]=await record(f);assert.ok(last.continuity.lineage.excludedIds.includes(prior.continuity.requestId));
});
test('an uncertain attempted return is never replayed; the next selection reviews a new fresh context',async()=>{
 const f=await setup('disabled');await switchToB(f);
 for(let turn=0;turn<2;turn++)pty(f,[...select('B response'),...confirm,{wait:'uncertain — process exited'}]);
 const launches=(await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(launches[1].args[0],'resume');assert.ok(!launches[2].args.includes('resume'));
 const records=await record(f);assert.equal(records[0].state,'uncertain');assert.equal(records[1].state,'uncertain');assert.notEqual(records[0].id,records[1].id);assert.notEqual(records[0].payloadHash,records[1].payloadHash);
});
test('unknown source-native compatibility gets a reviewed fresh bounded rebuild under the supported target',async()=>{
 const f=await setup();await writeFile(f.aFile,(await readFile(f.aFile,'utf8')).replace('0.171.0','0.170.0'));const before=await hash(f.aFile);
 const result=pty(f,[...select('A original'),...confirm,{wait:'accepted — correlated native turn'}]);assert.equal(result.code,0);assert.equal(await hash(f.aFile),before);
 const launch=JSON.parse((await readFile(f.env.RUNTIME_LOG,'utf8')).trim());assert.ok(!launch.args.includes('resume'));assert.deepEqual(JSON.parse(launch.args.at(-1)).history.map(item=>item.text),['A original request','A original answer']);
});
for(const mode of ['disabled','submit-only','wrong-hash','wrong-turn','background','wrong-root','unsupported','failure','malformed'])test(`default CLI ${mode} observation never accepts or advances coverage`,async()=>{
 const f=await setup(mode);await switchToB(f);
 const result=pty(f,[...select('B response'),...confirm,{wait:'uncertain — process exited'}]);assert.equal(result.code,0);
 const [attempt]=await record(f);assert.equal(attempt.state,'uncertain');assert.equal(attempt.targetNativeId,null);
 const journal=await TransferJournal.open(join(f.state,'transfers'));assert.ok(journal.contexts().every(context=>context.coveredIds.length===0));journal.close();
 if(mode==='unsupported'){const launch=(await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n').map(JSON.parse).at(-1);assert.ok(!launch.args.includes('resume'));assert.match(result.output,/receipt capability is unavailable/);}
});
