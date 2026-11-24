import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir,readFile,writeFile,access,realpath,unlink } from 'node:fs/promises';
import { join,resolve,dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { rollout,writeRollout,completed,ids } from './fixtures/codex/native.mjs';
import { entry,encode,ids as claudeIds } from './fixtures/claude/native.mjs';
import { TransferJournal } from '../dist/transfer-journal.js';
import { parseHandoffPrompt } from '../dist/handoff.js';
import { fixture as agyFixture } from './fixtures/agy/native.mjs';
import { tempDir } from './fixtures/temp.mjs';
import { stopHeartbeatChild } from './fixtures/heartbeat.mjs';
const repo=resolve('.'),id='12345678-1234-1234-1234-123456789abc';
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
async function setup(t) {
 const root=await realpath(await tempDir("agentswitch agy ' quoted "));
 const cwd=join(root,'workspace $()'),other=join(root,'other'),codex=join(root,'codex'),claude=join(root,'claude'),bin=join(root,'bin'),state=join(root,'state'),agy=join(root,'agy');
 await Promise.all([cwd,other,bin,join(agy,'cache')].map(p=>mkdir(p,{recursive:true})));
 const cache=join(agy,'cache','last_conversations.json');await writeFile(cache,JSON.stringify({[cwd]:id,[other]:'22345678-1234-1234-1234-123456789abc'}));
 const codexPath=await writeRollout(codex,rollout(cwd,ids[0],[completed('UserMessage','u','Codex fixture NEEDLE_SECRET',1),completed('AgentMessage','a','Codex answer',2)]));
 const bucket=join(claude,'projects','synthetic');await mkdir(bucket,{recursive:true});const claudePath=join(bucket,claudeIds[0]+'.jsonl');await writeFile(claudePath,encode([entry(claudeIds[0],cwd,'u',null,'user','Claude fixture NEEDLE_SECRET',{version:'2.1.330'}),entry(claudeIds[0],cwd,'a','u','assistant','Claude answer',{version:'2.1.330'})]));
 for(const name of ['codex','claude','agy'])await writeFile(join(bin,name),`#!${process.execPath}\nprocess.on('SIGHUP',()=>{});await import(${JSON.stringify(join(repo,'test/fixtures/runtime-child.mjs'))});\n`,{mode:0o700});
 const env={GROK_HOME:join(root,'grok'),AGENTSWITCH_AGY_ROOT:agy,OPENCODE_DB:join(root,'absent.db'),XDG_DATA_HOME:join(root,'xdg'),CODEX_HOME:codex,CODEX_SQLITE_HOME:codex,CLAUDE_CONFIG_DIR:claude,AGENTSWITCH_STATE_DIR:state,PATH:bin+':'+process.env.PATH,RUNTIME_TARGET:'agy',RUNTIME_LOG:join(root,'launches'),RUNTIME_SCENARIO:'interactive',AGY_PROBE_LOG:join(root,'probes'),NODE_NO_WARNINGS:'1',...(process.env.AGENTSWITCH_TEST_ENTRY?{CLI_ENTRY_MODULE:process.env.AGENTSWITCH_TEST_ENTRY}:{})};
 const files=[cache,codexPath,claudePath];return {root,cwd,other,cache,bin,state,env,files,before:await Promise.all(files.map(hash))};
}
function pty(f,actions,args=[],all=false) {const r=spawnSync('python3',['test/fixtures/drive-integration.py'],{encoding:'utf8',input:JSON.stringify({node:process.execPath,runner:join(repo,'test/fixtures/integration-runner.mjs'),cwd:f.cwd,env:f.env,actions,args,rows:60,columns:210}),timeout:40000,maxBuffer:8*1024*1024});assert.equal(r.status,0,r.stderr);return all?JSON.parse(r.stdout):JSON.parse(r.stdout)[0];}
const select=(source,publicText=false)=>[{wait:'Enter preview'},{send:source==='agy'?(publicText?'Agy public fixture':id):source==='codex'?'Codex fixture':'Claude fixture'},{wait:'Enter preview'},{send:'\r'},{wait:'Enter choose target'},{send:'\r'},{wait:'C edit request'}];
const target=[{send:'\x1b[D'},{wait:'Target: grok'},{send:'\x1b[D'},{wait:'Target: agy'}];
const clear=[{send:'c'},{wait:'Current request (sent separately'},{send:'\x15\r'},{wait:'Current request: '}];
const finish=[{send:'\r'},{wait:'Exact initial user prompt'},{send:'\r'},{wait:'READY'},{send:'hello\n'},{wait:'INPUT "hello\\n"'},{send:'quit\n'},{wait:'uncertain — process exited'}];
const launches=async f=>(await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n').map(JSON.parse);
async function records(f){const j=await TransferJournal.open(join(f.state,'transfers'));try{return j.list();}finally{j.close();}}
async function publicSource(f,options={}) {
 const native=await agyFixture(f.env.AGENTSWITCH_AGY_ROOT,f.cwd,{nativeId:id,...options});
 f.files.push(native.path,native.history);f.before=await Promise.all(f.files.map(hash));return native;
}
for(const destination of ['codex','claude'])test(`default CLI agy→${destination} transfers reviewed public text and keeps excluded native content private`,async t=>{
 const f=await setup(t);const native=await publicSource(f,{kind:'tool'});f.env.RUNTIME_TARGET=destination;
 const r=pty(f,[...select('agy',true),...(destination==='claude'?[{send:'\x1b[C'},{wait:'Target: claude'}]:[]),{send:'x'},{wait:'Literal redaction'},{send:'NEEDLE_SECRET\r'},{wait:'Redactions: 1'},{send:'\r'},{wait:'tool and system steps: 2 (indexes 1–2)'},{wait:'Exact initial user prompt'},{send:'\r'},{wait:'READY'},{send:'hello\n'},{wait:'INPUT "hello\\n"'},{send:'quit\n'},{wait:'uncertain — process exited'}]);
 assert.equal(r.restored,true);const [launch]=await launches(f);assert.equal(launch.cwd,f.cwd);assert.deepEqual(launch.tty,[true,true,true]);const wire=launch.args.at(-1),payload=JSON.parse(wire);
 assert.equal(payload.history.length,2);assert.ok(parseHandoffPrompt(wire).history.every(x=>x.origin.agent==='agy'));assert.match(wire,/\[REDACTED\]/);assert.doesNotMatch(wire,/PRIVATE_|NEEDLE_SECRET|GENERIC|EXCLUDED_TOOL/);
 const [record]=await records(f);assert.equal(record.state,'uncertain');assert.equal(record.completeness,'complete');const {readArchiveSnapshot}=await import('../dist/archive.js');const archive=await readArchiveSnapshot(record.archive);assert.equal(archive.items.length,2);assert.doesNotMatch(JSON.stringify(archive),/PRIVATE_|NEEDLE_SECRET/);assert.deepEqual(await Promise.all(f.files.map(hash)),f.before);
 const before=(await launches(f)).length;pty(f,[{wait:'EXPLICIT FRESH RECOVERY'},{wait:'Enter preview'},{send:'\x03'}],['transfers','retry',record.id]);assert.equal((await launches(f)).length,before);
});
test('agy public outgoing cancellation, omission retrieval and explicit workspace override use shared consent flow',async t=>{
 const f=await setup(t);await publicSource(f,{user:'Agy public fixture '+'large '.repeat(5000)});f.env.RUNTIME_TARGET='claude';
 pty(f,[...select('agy',true),{send:'\x1b[C'},{wait:'Target: claude'},{send:'\r'},{wait:'Exact initial user prompt'},{send:'\x03'}]);await assert.rejects(access(f.env.RUNTIME_LOG));assert.equal((await records(f)).length,0);
 pty(f,[...select('agy',true),{send:'\x1b[C'},{wait:'Target: claude'},{send:'w'},{wait:'Explicit workspace override'},{send:f.other+'\r'},{wait:'Exact initial user prompt'},{send:'\r'},{wait:'READY'},{send:'quit\n'},{wait:'uncertain — process exited'}]);
 const [launch]=await launches(f);assert.equal(launch.cwd,f.other);const payload=JSON.parse(launch.args.at(-1));assert.ok(Buffer.byteLength(launch.args.at(-1))<=16384);assert.equal(payload.omissions.count,1);const [record]=await records(f);const {readArchiveSnapshot}=await import('../dist/archive.js');const archive=await readArchiveSnapshot(record.archive);assert.ok(archive.items.some(x=>x.text.includes('large '.repeat(100))));assert.equal(record.omittedItemIds.length,1);
});
test('agy public source revalidation blocks changed native bytes before publishing or launch',async t=>{
 const f=await setup(t);const native=await publicSource(f);f.env.RUNTIME_TARGET='claude';const r=pty(f,[...select('agy',true),{send:'\x1b[C'},{wait:'Target: claude'},{send:'\r'},{wait:'Exact initial user prompt'},{append:{path:native.history,text:'{}\n'}},{send:'\r'},{wait:'Source changed after preview'}]);assert.equal(r.code,1);await assert.rejects(access(f.env.RUNTIME_LOG));assert.equal((await records(f)).length,0);
});
test('agy complete local public source preserves exact empty-request native open',async t=>{
 const f=await setup(t);await publicSource(f);pty(f,[...select('agy',true),...target,...clear,{send:'\r'},{wait:'Exact current request'},{send:'\r'},{wait:'READY'},{send:'quit\n'},{wait:'uncertain — process exited'}]);
 assert.deepEqual((await launches(f))[0].args,['--conversation',id]);const [record]=await records(f);assert.equal(record.archive,null);assert.equal(record.prompt,'');assert.equal(record.completeness,'complete');assert.equal(record.targetNativeId,null);
});
test('agy outgoing missing target refuses preparation without archive, journal or launch',async t=>{
 const f=await setup(t);await publicSource(f);await unlink(join(f.bin,'claude'));f.env.PATH=f.bin+':'+dirname(process.execPath)+':/usr/bin:/bin';
 pty(f,[...select('agy',true),{send:'\x1b[C'},{wait:'Target: claude'},{send:'\r'},{wait:'not found or is not executable'},{send:'\x03'}]);await assert.rejects(access(f.env.RUNTIME_LOG));await assert.rejects(access(join(f.state,'archives')));assert.equal((await records(f)).length,0);
});
for(const source of ['codex','claude'])test(`default CLI ${source}→agy uses reviewed bounded redacted context and inherited terminal`,async t=>{
 const f=await setup(t);const r=pty(f,[...select(source),...target,{send:'c'},{wait:'Current request (sent separately'},{send:'\x15--literal $(touch sentinel); `echo no` NEEDLE_SECRET\r'},{wait:'Current request: --literal'},{send:'x'},{wait:'Literal redaction'},{send:'NEEDLE_SECRET\r'},{wait:'Redactions: 1'},...finish]);
 assert.equal(r.code,0);assert.equal(r.restored,true);assert.equal(r.sampledWhileAlive,true);const [launch]=await launches(f);assert.equal(launch.cwd,f.cwd);assert.deepEqual(launch.tty,[true,true,true]);assert.equal(launch.args.length,2);assert.equal(launch.args[0],'--prompt-interactive');
 const wire=launch.args[1],prompt=JSON.parse(wire);assert.equal(prompt.currentRequest,'--literal $(touch sentinel); `echo no` [REDACTED]');assert.equal(prompt.history.length,2);assert.ok(parseHandoffPrompt(wire).history.every(item=>item.origin.agent===source));assert.ok(Buffer.byteLength(wire)<=16384);assert.doesNotMatch(wire,/NEEDLE_SECRET|PRIVATE_/);await assert.rejects(access(join(f.cwd,'sentinel')));assert.deepEqual(await Promise.all(f.files.map(hash)),f.before);
 const [record]=await records(f);assert.equal(record.state,'uncertain');assert.equal(record.targetNativeId,null);assert.equal(record.continuity.targetRef,null);assert.equal(record.observation,undefined);assert.equal(record.writer,'stopped');
});
test('agy native open requires explicitly cleared draft, exact cache ID/cwd and sends no history or new request',async t=>{
 const f=await setup(t);const r=pty(f,[...select('agy'),...target,{send:'\r'},{wait:'Clear the request explicitly'},...clear,{send:'\r'},{wait:'Open the exact cached Antigravity conversation'},{send:'\r'},{wait:'READY'},{send:'quit\n'},{wait:'uncertain — process exited'}]);assert.equal(r.restored,true);assert.deepEqual((await launches(f))[0].args,['--conversation',id]);
 const [record]=await records(f);assert.equal(record.completeness,'unknown');assert.equal(record.continuity,undefined);assert.equal(record.archive,null);assert.equal(record.prompt,'');assert.equal(record.targetNativeId,null);assert.deepEqual(await Promise.all(f.files.map(hash)),f.before);
});
test('agy metadata discovery/filter/global search does no provider probes or launches',async t=>{
 const f=await setup(t);const r=pty(f,[{wait:'Enter preview'},{send:'\x1b[D'},{wait:'Agent: grok'},{send:'\x1b[D'},{wait:'Agent: agy'},{send:'\t'},{wait:'Scope: global'},{send:'22345678'},{wait:'Last cached conversation 22345678'},{send:'\x03'}]);assert.equal(r.restored,true);await assert.rejects(access(f.env.AGY_PROBE_LOG));await assert.rejects(access(f.env.RUNTIME_LOG));assert.deepEqual(await Promise.all(f.files.map(hash)),f.before);
});
for(const destination of ['codex','claude'])test(`agy→${destination} cache-only source refuses outgoing history instead of fabricating empty transcript`,async t=>{
 const f=await setup(t);pty(f,[...select('agy'),...(destination==='claude'?[{send:'\x1b[C'},{wait:'Target: claude'}]:[]),{send:'\r'},{wait:'Public history is unavailable'},{send:'\x03'}]);await assert.rejects(access(f.env.AGY_PROBE_LOG));await assert.rejects(access(f.env.RUNTIME_LOG));assert.equal((await records(f)).length,0);
});
test('agy cancelled target confirmation publishes no archive or journal and no launch',async t=>{
 const f=await setup(t);const r=pty(f,[...select('claude'),...target,{send:'\r'},{wait:'Exact initial user prompt'},{send:'\x03'}]);assert.equal(r.restored,true);await assert.rejects(access(f.env.RUNTIME_LOG));await assert.rejects(access(join(f.state,'archives')));assert.equal((await records(f)).length,0);
});
test('agy incoming omissions keep a retrievable full archive within the complete transport budget',async t=>{
 const f=await setup(t);await writeRollout(f.env.CODEX_HOME,rollout(f.cwd,ids[0],[completed('UserMessage','u','Codex fixture '+'large '.repeat(5000),1),completed('AgentMessage','a','Small answer',2)]));
 const r=pty(f,[...select('codex'),...target,...finish]);assert.equal(r.restored,true);const wire=(await launches(f))[0].args[1],payload=JSON.parse(wire);assert.ok(Buffer.byteLength(wire)<=16384);assert.equal(payload.omissions.count,1);
 const [record]=await records(f);const {readArchiveSnapshot}=await import('../dist/archive.js');const archive=await readArchiveSnapshot(record.archive);assert.equal(archive.items.length,2);assert.ok(archive.items.some(item=>item.text.includes('large '.repeat(100))));assert.equal(record.omittedItemIds.length,1);
});
test('agy incoming workspace override is explicit and cache-only native override cannot launch',async t=>{
 const f=await setup(t);pty(f,[...select('codex'),...target,{send:'w'},{wait:'Explicit workspace override'},{send:f.other+'\r'},{wait:'Exact initial user prompt'},{send:'\r'},{wait:'READY'},{send:'quit\n'},{wait:'uncertain — process exited'}]);assert.equal((await launches(f))[0].cwd,f.other);
 pty(f,[...select('agy'),...target,...clear,{send:'w'},{wait:'Explicit workspace override'},{send:f.other+'\r'},{wait:'requires its recorded workspace'},{send:'\x03'}]);assert.equal((await launches(f)).length,1);
});
test('agy unknown delivery survives restart without replay; explicit fresh retry stays uncertain',async t=>{
 const f=await setup(t);pty(f,[...select('codex'),...target,...finish]);const [record]=await records(f);pty(f,[{wait:'EXPLICIT FRESH RECOVERY'},{wait:'Enter preview'},{send:'\r'},{wait:'Enter choose target'},{send:'\r'},{wait:'C edit request'},...target,...finish],['transfers','retry',record.id]);const all=await records(f);assert.equal(all.length,2);assert.ok(all.every(x=>x.state==='uncertain'&&x.targetNativeId===null));assert.equal((await launches(f)).length,2);
});
for(const scenario of ['auth','exit7','self-signal'])test(`agy ${scenario} preserves native diagnostics/status and restores terminal`,async t=>{
 const f=await setup(t);f.env.RUNTIME_SCENARIO=scenario;const r=pty(f,[...select('codex'),...target,{send:'\r'},{wait:'Exact initial user prompt'},{send:'\r'},{wait:'uncertain — process exited'}]);assert.equal(r.restored,true);assert.equal(r.code,scenario==='exit7'?7:1);assert.equal((await records(f))[0].writer,'stopped');if(scenario==='auth')assert.match(r.output,/SYNTHETIC AUTH REFUSAL/);
});
for(const signal of ['SIGINT','SIGTERM'])test(`agy raw child receives ${signal} and terminal is restored`,async t=>{
 const f=await setup(t);f.env.RUNTIME_SCENARIO='raw';const r=pty(f,[...select('codex'),...target,{send:'\r'},{wait:'Exact initial user prompt'},{send:'\r'},{wait:'READY'},{signal},{wait:'uncertain — process exited'}]);assert.equal(r.restored,true);assert.equal((await records(f))[0].exit.signal,signal);
});
test('agy missing executable recovers without provider launch',async t=>{
 const f=await setup(t);await unlink(join(f.bin,'agy'));f.env.PATH=f.bin+':'+dirname(process.execPath)+':/usr/bin:/bin';pty(f,[...select('codex'),...target,{send:'\r'},{wait:'not found or is not executable'},{send:'\x03'}]);assert.equal((await records(f)).length,0);
});
test('agy changed metadata after confirmation cannot dispatch or publish a journal',async t=>{
 const f=await setup(t);const r=pty(f,[...select('agy'),...target,...clear,{send:'\r'},{wait:'Exact current request'},{append:{path:f.cache,text:'invalid changed suffix'}},{send:'\r'},{wait:'Selected source is unavailable'}]);assert.equal(r.code,1);assert.equal(r.restored,true);await assert.rejects(access(f.env.RUNTIME_LOG));assert.equal((await records(f)).length,0);
});
test('agy native open refuses an app-owned crashed unknown writer without takeover',async t=>{
 const f=await setup(t);f.env.CLI_TRACK_PID_COMMIT='1';f.env.CLI_CHILD_HEARTBEAT=join(f.root,'child-heartbeat');t.after(()=>stopHeartbeatChild(f.env.CLI_CHILD_HEARTBEAT));
 const first=[...select('agy'),...target,...clear,{send:'\r'},{wait:'Exact current request'},{send:'\r'},{wait:'READY'},{waitPostPidCommit:true},{assertWrapperAlive:true},{killWrapper:true}];
 const results=pty(f,[...first,{assertLiveChild:true},{start:true},...select('agy'),...target,...clear,{send:'\r'},{wait:'ownership is unknown'},{send:'\x03'},{assertLiveChild:true}],[],true);
 const [prior]=await records(f);assert.equal(prior.writer,'unknown');assert.equal(prior.state,'pending');assert.equal(results[0].code,-9);assert.equal(results[1].restored,true);assert.equal(results[1].sampledWhileAlive,true);assert.match(results[0].output,/PID_COMMIT_DONE/);assert.equal(prior.childPid,(await launches(f))[0].pid);assert.equal((await launches(f)).length,1);assert.equal((await records(f)).length,1);
 for(const result of results){assert.equal(result.liveChildChecks.length,1);assert.equal(result.liveChildChecks[0].pid,prior.childPid);assert.ok(result.liveChildChecks[0].after>result.liveChildChecks[0].before);}
});
