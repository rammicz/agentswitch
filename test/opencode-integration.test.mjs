import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp,mkdir,readFile,writeFile,readdir,access,realpath,unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture,id } from './fixtures/opencode/native.mjs';
import { rollout,writeRollout,completed,ids as codexIds } from './fixtures/codex/native.mjs';
import { entry,encode,ids as claudeIds } from './fixtures/claude/native.mjs';
import { TransferJournal } from '../dist/transfer-journal.js';
const repo=resolve('.');
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
async function setup(target='opencode') {
 const root=await mkdtemp(join(tmpdir(),"agentswitch OpenCode ' quoted "));const cwd=join(root,'workspace $()'),other=join(root,'other'),codex=join(root,'codex'),claude=join(root,'claude'),bin=join(root,'bin'),state=join(root,'state');await Promise.all([cwd,other,bin].map(p=>mkdir(p,{recursive:true})));
 const path=await fixture(join(root,'opencode','opencode.db'),cwd);
 const codexPath=await writeRollout(codex,rollout(cwd,codexIds[0],[completed('UserMessage','u','Codex fixture NEEDLE_SECRET',1),completed('AgentMessage','a','Codex answer',2)]));
 const bucket=join(claude,'projects','synthetic');await mkdir(bucket,{recursive:true});const claudePath=join(bucket,claudeIds[0]+'.jsonl');await writeFile(claudePath,encode([entry(claudeIds[0],cwd,'u',null,'user','Claude fixture NEEDLE_SECRET',{version:'2.1.330'}),entry(claudeIds[0],cwd,'a','u','assistant','Claude answer',{version:'2.1.330'})]));
 for(const name of ['codex','claude','opencode'])await writeFile(join(bin,name),`#!${process.execPath}\nprocess.on('SIGHUP',()=>{});await import(${JSON.stringify(join(repo,'test/fixtures/runtime-child.mjs'))});\n`,{mode:0o700});
 const env={OPENCODE_DB:path,XDG_DATA_HOME:join(root,'xdg-data'),CODEX_HOME:codex,CODEX_SQLITE_HOME:codex,CLAUDE_CONFIG_DIR:claude,AGENTSWITCH_STATE_DIR:state,PATH:bin+':'+process.env.PATH,RUNTIME_TARGET:target,RUNTIME_LOG:join(root,'launches'),RUNTIME_SCENARIO:'interactive',NODE_NO_WARNINGS:'1',...(process.env.AGENTSWITCH_TEST_ENTRY?{CLI_ENTRY_MODULE:process.env.AGENTSWITCH_TEST_ENTRY}:{})};
 const files=[path,codexPath,claudePath];return {root,cwd,other,codex,claude,path,bin,state,env,files,before:await Promise.all(files.map(hash))};
}
function pty(f,actions,args=[]) {const result=spawnSync('python3',['test/fixtures/drive-integration.py'],{encoding:'utf8',input:JSON.stringify({node:process.execPath,runner:join(repo,'test/fixtures/integration-runner.mjs'),cwd:f.cwd,env:f.env,actions,args,rows:60,columns:210}),timeout:40000,maxBuffer:8*1024*1024});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout)[0];}
const needle={opencode:'OpenCode public',codex:'Codex fixture',claude:'Claude fixture'};
const select=source=>[{wait:'Enter preview'},{send:needle[source]},{wait:'Enter preview'},{send:'\r'},{wait:'Enter choose target'},{send:'\r'},{wait:'C edit request'}];
const target=agent=>Array.from({length:['codex','claude','opencode'].indexOf(agent)},(_,i)=>[{send:'\x1b[C'},{wait:'Target: '+['claude','opencode'][i]}]).flat();
const request=[{send:'c'},{wait:'Current request (sent separately'},{send:'\x15--literal $(touch sentinel); `echo no` NEEDLE_SECRET\r'},{wait:'Current request: --literal'}];
const redact=[{send:'x'},{wait:'Literal redaction'},{send:'NEEDLE_SECRET\r'},{wait:'Redactions: 1'}];
const finish=[{send:'\r'},{wait:'Exact initial user prompt'},{send:'\r'},{wait:'READY'},{send:'hello\n'},{wait:'INPUT "hello\\n"'},{send:'quit\n'},{wait:'uncertain — process exited'}];
const launches=async f=>(await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n').map(JSON.parse);
async function records(f){const journal=await TransferJournal.open(join(f.state,'transfers'));try{return journal.list();}finally{journal.close();}}
for(const [source,destination]of [['opencode','codex'],['codex','opencode'],['opencode','claude'],['claude','opencode']])test(`default CLI ${source}→${destination} uses reviewed bounded redacted public history and inherited terminal`,async()=>{
 const f=await setup(destination);const result=pty(f,[...select(source),...target(destination),...request,...redact,...finish]);assert.equal(result.code,0);assert.equal(result.restored,true);assert.equal(result.sampledWhileAlive,true);
 const [launch]=await launches(f);assert.deepEqual(launch.tty,[true,true,true]);assert.equal(launch.cwd,await realpath(f.cwd));
 const wire=destination==='opencode'?launch.args[1].slice('--prompt='.length):launch.args.at(-1);const prompt=JSON.parse(wire);assert.equal(prompt.currentRequest,'--literal $(touch sentinel); `echo no` [REDACTED]');assert.ok(Buffer.byteLength(wire)<=16384);assert.ok(prompt.history.some(item=>item.origin.agent===source));assert.doesNotMatch(wire,/PRIVATE_|NEEDLE_SECRET/);
 if(destination==='opencode')assert.deepEqual(launch.args,[await realpath(f.cwd),'--prompt='+wire]);
 assert.ok(!launch.args.some(arg=>/skip-permissions|yolo|--session|--continue|--fork/.test(arg)));
 assert.ok(result.output.replace(/\r?\n/g,'').includes(JSON.stringify(wire)));assert.match(result.output,/No supported native receipt transport|conditional on native hook/);assert.deepEqual(await Promise.all(f.files.map(hash)),f.before);
 const [record]=await records(f);assert.equal(record.target,destination);assert.equal(record.state,'uncertain');assert.equal(record.targetNativeId,null);assert.equal(record.writer,'stopped');assert.equal(record.source.agent,source);await assert.rejects(access(join(f.cwd,'sentinel')));
});
test('OpenCode native requires an explicitly empty draft, keeps nonempty draft, and opens exact ses_ without a prompt',async()=>{
 const f=await setup();const result=pty(f,[...select('opencode'),{send:'\x1b[D'},{wait:'Target: opencode'},...request,{send:'\r'},{wait:'Clear the request explicitly'},{send:'c'},{wait:'Current request (sent separately'},{send:'\x15\r'},{wait:'Current request: '},{send:'\r'},{wait:'without an initial request'},{send:'\r'},{wait:'READY'},{send:'quit\n'},{wait:'uncertain — process exited'}]);assert.equal(result.restored,true);
 assert.deepEqual((await launches(f))[0].args,[await realpath(f.cwd),'--session='+id]);const [record]=await records(f);assert.equal(record.mode,'native-resume');assert.equal(record.prompt,'');assert.equal(record.archive,null);assert.equal(record.targetNativeId,null);assert.match(result.output,/--literal \$\(touch sentinel\)/);assert.deepEqual(await Promise.all(f.files.map(hash)),f.before);
});
test('OpenCode nonempty native draft recovers via explicit F and is transported intact in reviewed fresh JSON',async()=>{
 const f=await setup();pty(f,[...select('opencode'),...target('opencode'),...request,{send:'\r'},{wait:'Clear the request explicitly'},{send:'f'},{wait:'Fresh context: explicitly selected'},...finish]);const [launch]=await launches(f);assert.equal(JSON.parse(launch.args[1].slice(9)).currentRequest,'--literal $(touch sentinel); `echo no` NEEDLE_SECRET');assert.ok(!launch.args.some(a=>a.startsWith('--session=')));
});
test('OpenCode recorded workspace override is an explicit fresh context in the selected canonical cwd',async()=>{
 const f=await setup();pty(f,[...select('opencode'),...target('opencode'),{send:'w'},{wait:'Explicit workspace override'},{send:f.other+'\r'},{wait:'(override)'},...finish]);const [launch]=await launches(f);assert.equal(launch.cwd,await realpath(f.other));assert.equal(launch.args[0],await realpath(f.other));assert.ok(launch.args[1].startsWith('--prompt='));
});
for(const version of ['2.3.2','1.19.7'])test(`OpenCode incompatible ${version} leaves recovery visible and never launches`,async()=>{
 const f=await setup();f.env.OPENCODE_FAKE_VERSION=version;pty(f,[...select('codex'),...target('opencode'),{send:'\r'},{wait:'Target version is unsupported'},{send:'\x03'}]);await assert.rejects(access(f.env.RUNTIME_LOG));assert.equal((await records(f)).length,0);
});
test('missing OpenCode executable leaves cancellation/recovery without creating a transfer',async()=>{
 const f=await setup();await unlink(join(f.bin,'opencode'));f.env.PATH=f.bin+':'+dirname(process.execPath)+':/usr/bin:/bin';pty(f,[...select('codex'),...target('opencode'),{send:'\r'},{wait:'not found or is not executable'},{send:'\x03'}]);await assert.rejects(access(f.env.RUNTIME_LOG));assert.equal((await records(f)).length,0);
});
import { dirname } from 'node:path';
test('cancelled OpenCode confirmation creates neither archive nor delivery and restores terminal',async()=>{
 const f=await setup();const result=pty(f,[...select('claude'),...target('opencode'),{send:'\r'},{wait:'Exact initial user prompt'},{send:'\x03'}]);assert.equal(result.restored,true);await assert.rejects(access(f.env.RUNTIME_LOG));await assert.rejects(access(join(f.state,'archives')));assert.equal((await records(f)).length,0);
});
test('OpenCode unknown delivery survives restart without replay and fresh recovery is explicit',async()=>{
 const f=await setup();pty(f,[...select('codex'),...target('opencode'),...finish]);const [record]=await records(f);assert.equal(record.state,'uncertain');pty(f,[{wait:'EXPLICIT FRESH RECOVERY'},{wait:'Enter preview'},{send:'\r'},{wait:'Enter choose target'},{send:'\r'},{wait:'C edit request'},...target('opencode'),...finish],['transfers','retry',record.id]);const all=await records(f);assert.equal(all.length,2);assert.equal((await launches(f)).length,2);assert.equal(all.find(x=>x.id!==record.id).retryOf,record.id);
});
test('fake 1.19.6 deletion after native validation returns home without creating a replacement or auto request',async()=>{
 const f=await setup();f.env.OPENCODE_FAKE_DELETE_AFTER_VALIDATE='1';const result=pty(f,[...select('opencode'),...target('opencode'),{send:'c'},{wait:'Current request (sent separately'},{send:'\x15\r'},{wait:'Current request: '},{send:'\r'},{wait:'Exact current request'},{send:'\r'},{wait:'SYNTHETIC NATIVE SESSION DELETED'},{wait:'uncertain — process exited'}]);assert.equal(result.restored,true);const [launch]=await launches(f);assert.deepEqual(launch.args,[await realpath(f.cwd),'--session='+id]);assert.equal(launch.created,false);assert.equal(launch.autoRequest,false);assert.equal((await records(f))[0].state,'uncertain');
});

test('OpenCode source filters combine with exact folder/global public-content search',async()=>{
 const f=await setup();const db=new DatabaseSync(f.path);db.prepare('INSERT INTO session SELECT ?,?,workspace_id,parent_id,?,version,time_created,time_updated,time_archived,revert FROM session WHERE id=?').run('ses_other',f.other,'Other OpenCode',id);db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('msg_other','ses_other',5,5,JSON.stringify({role:'user',time:{created:5}}));db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_other','msg_other','ses_other',5,5,JSON.stringify({type:'text',text:'global-only needle'}));db.close();
 const {NativeCatalog}=await import('../dist/native-catalog.js');const {SearchIndex}=await import('../dist/search-index.js');const catalog=await NativeCatalog.create(f.env);const index=await SearchIndex.open({directory:join(f.root,'search'),sources:catalog.sources()});await catalog.refresh(index);
 const query={text:'NEEDLE_SECRET',agent:'all',scope:'folder',workspace:f.cwd};assert.deepEqual(new Set((await index.query(query)).map(x=>x.agent)),new Set(['codex','claude','opencode']));assert.equal((await index.query({...query,agent:'opencode'})).length,1);assert.equal((await index.query({...query,text:'global-only'})).length,0);assert.equal((await index.query({...query,text:'global-only',agent:'opencode',scope:'global'})).length,1);await index.close();
 // Exercise the real keyboard source cycle separately from target selection.
 const result=pty(f,[{wait:'Enter preview'},{send:'\x1b[C'},{wait:'Agent: codex'},{send:'\x1b[C'},{wait:'Agent: claude'},{send:'\x1b[C'},{wait:'Agent: opencode'},{send:'\t'},{wait:'Scope: global'},{send:'global-only'},{wait:'Other OpenCode'},{send:'\x03'}]);assert.equal(result.restored,true);await assert.rejects(access(f.env.RUNTIME_LOG));
});
test('OpenCode omissions retain a usable redacted archive while transport stays within the full byte budget',async()=>{
 const f=await setup('claude');const db=new DatabaseSync(f.path);db.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify({type:'text',text:'OpenCode public NEEDLE_SECRET '+'huge '.repeat(5000)}),'prt_b');db.close();
 const result=pty(f,[...select('opencode'),...target('claude'),...redact,...finish]);assert.match(result.output,/Omitted: [a-f0-9]{64}/);const wire=(await launches(f))[0].args.at(-1);const prompt=JSON.parse(wire);assert.ok(Buffer.byteLength(wire)<=16384);assert.equal(prompt.omissions.count,1);
 const [record]=await records(f);const {readArchiveSnapshot}=await import('../dist/archive.js');const snapshot=await readArchiveSnapshot(record.archive);assert.equal(snapshot.items.length,5);assert.ok(snapshot.items.some(item=>item.text.includes('huge ')));assert.doesNotMatch(JSON.stringify(snapshot),/NEEDLE_SECRET|PRIVATE_/);assert.ok(record.omittedItemIds.length===1);
 const archived=spawnSync(process.execPath,[join(repo,'dist/cli.js'),'archive','read','--directory',record.archive.directory,'--archive',record.archive.id,'--item','1'],{encoding:'utf8',env:{...process.env,...f.env}});assert.equal(archived.status,0,archived.stderr);assert.match(JSON.parse(archived.stdout).text,/OpenCode public \[REDACTED\]/);
});
test('selected OpenCode ID removed during capability preparation is refused at dispatch without a journal or model turn',async()=>{
 const f=await setup();f.env.OPENCODE_FAKE_DELETE_DURING_HELP='1';const result=pty(f,[...select('opencode'),...target('opencode'),{send:'c'},{wait:'Current request (sent separately'},{send:'\x15\r'},{wait:'Current request: '},{send:'\r'},{wait:'Exact current request'},{send:'\r'},{wait:'Selected source is unavailable'}]);assert.equal(result.code,1);assert.equal(result.restored,true);await assert.rejects(access(f.env.RUNTIME_LOG));assert.equal((await records(f)).length,0);
});
for(const scenario of ['auth','exit7','self-signal'])test(`OpenCode default CLI ${scenario} preserves native status and restores terminal`,async()=>{
 const f=await setup();f.env.RUNTIME_SCENARIO=scenario;const result=pty(f,[...select('codex'),...target('opencode'),{send:'\r'},{wait:'Exact initial user prompt'},{send:'\r'},{wait:'uncertain — process exited'}]);assert.equal(result.restored,true);assert.equal(result.code,scenario==='exit7'?7:1);const [record]=await records(f);assert.equal(record.state,'uncertain');assert.equal(record.writer,'stopped');if(scenario==='self-signal')assert.equal(record.exit.signal,'SIGTERM');if(scenario==='auth')assert.match(result.output,/SYNTHETIC AUTH REFUSAL/);
});
for(const name of ['SIGINT','SIGTERM'])test(`OpenCode raw terminal receives ${name} and leaves no active writer`,async()=>{
 const f=await setup();f.env.RUNTIME_SCENARIO='raw';const result=pty(f,[...select('codex'),...target('opencode'),{send:'\r'},{wait:'Exact initial user prompt'},{send:'\r'},{wait:'READY'},{signal:name},{wait:'uncertain — process exited'}]);assert.equal(result.restored,true);assert.equal(result.code,1);const [record]=await records(f);assert.equal(record.exit.signal,name);assert.equal(record.writer,'stopped');
});
test('matching OpenCode version with incompatible help fails before publication or launch',async()=>{
 const f=await setup();f.env.OPENCODE_FAKE_HELP='opencode [project]\n--prompt only';pty(f,[...select('codex'),...target('opencode'),{send:'\r'},{wait:'capability is missing'},{send:'\x03'}]);await assert.rejects(access(f.env.RUNTIME_LOG));assert.equal((await records(f)).length,0);
});
test('default CLI accepts an external OpenCode DB with a shared ancestor and separate application state',async()=>{
 const f=await setup();f.env.OPENCODE_DB=await fixture(join(f.root,'opencode.db'),f.cwd);const result=pty(f,[...select('codex'),...target('opencode'),...finish]);assert.equal(result.code,0);assert.equal((await launches(f)).length,1);
});
