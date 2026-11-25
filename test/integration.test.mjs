import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, stat, rename, symlink, access, realpath, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { rollout, writeRollout, completed, ids as codexIds } from './fixtures/codex/native.mjs';
import { entry, encode, ids as claudeIds } from './fixtures/claude/native.mjs';
import { tempDir } from './fixtures/temp.mjs';
import { stopHeartbeatChild } from './fixtures/heartbeat.mjs';

const repo=resolve('.');
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
async function setup(target='claude') {
 const root=await tempDir('agentswitch-cli-');
 const cwd=join(root,'workspace'),other=join(root,'other'),child=join(cwd,'nested'),codex=join(root,'codex'),claude=join(root,'claude'),state=join(root,'state');
 await Promise.all([cwd,other,child,claude].map(path=>mkdir(path,{recursive:true})));
 const files=[];
 files.push(await writeRollout(codex,rollout(cwd,codexIds[0],[completed('UserMessage','u','public source NEEDLE_SECRET',1),completed('AgentMessage','a','public answer',2)])));
 files.push(await writeRollout(codex,rollout(child,codexIds[1],[completed('UserMessage','u','nested-folder-only',1)])));
 files.push(await writeRollout(codex,rollout(other,codexIds[2],[completed('UserMessage','u','other-folder-only',1)])));
 const bucket=join(claude,'projects','synthetic');await mkdir(bucket,{recursive:true});
 const claudePath=join(bucket,claudeIds[0]+'.jsonl');
 await writeFile(claudePath,encode([entry(claudeIds[0],cwd,'u',null,'user','Claude public NEEDLE_SECRET',{version:'2.1.330'}),entry(claudeIds[0],cwd,'a','u','assistant','Claude answer',{version:'2.1.330'})]));files.push(claudePath);
 const bin=join(root,'bin');await mkdir(bin);
 for(const name of ['codex','claude']) {const path=join(bin,name);await writeFile(path,`#!${process.execPath}\nprocess.on('SIGHUP',()=>{});\nawait import('${join(repo,'test/fixtures/runtime-child.mjs')}');\n`,{mode:0o700});}
 const env={GROK_HOME:join(root,'grok'),AGENTSWITCH_AGY_ROOT:join(root,'agy'),XDG_DATA_HOME:join(root,'xdg-data'),OPENCODE_DB:join(root,'opencode','opencode.db'),CODEX_HOME:codex,CODEX_SQLITE_HOME:codex,CLAUDE_CONFIG_DIR:claude,AGENTSWITCH_STATE_DIR:state,RUNTIME_TARGET:target,RUNTIME_LOG:join(root,'launches'),RUNTIME_SCENARIO:'interactive',PATH:bin+':'+process.env.PATH,NODE_NO_WARNINGS:'1'};
 return {root,cwd,other,child,codex,claude,state,files,env,before:await Promise.all(files.map(hash))};
}
function pty(f,actions,args=[],terminal={}) {
 const child=spawnSync('python3',['test/fixtures/drive-integration.py'],{encoding:'utf8',input:JSON.stringify({node:process.execPath,runner:join(repo,'test/fixtures/integration-runner.mjs'),cwd:f.cwd,env:f.env,actions,args,...terminal}),timeout:40000,maxBuffer:8*1024*1024});
 if(child.error)throw new Error(`PTY driver failed: ${child.error.code??'unknown error'}; signal=${child.signal??'none'}; timeout=40000ms. ${child.error.message}\n${child.stderr?.slice(-4096)??''}`,{cause:child.error});
 assert.equal(child.status,0,`PTY driver exited status=${child.status}; signal=${child.signal??'none'}\n${child.stderr}`);return JSON.parse(child.stdout);
}
const list=[{wait:'Enter preview'}];
const select=(provider)=>[{send:provider==='codex'?'public source':'Claude public'},{wait:'Enter preview'},{send:'\r'},{wait:'Enter choose target'},{send:'\r'},{wait:'C edit request'}];
const redact=[{send:'x'},{wait:'Literal redaction'},{send:'NEEDLE_SECRET\r'},{wait:'Redactions  1'}];
const request=[{send:'c'},{wait:'Current request (sent separately'},{send:'\u0015Do next NEEDLE_SECRET\r'},{wait:'Current request  Do next'}];
const finish=[{send:'\r'},{wait:'Exact initial user prompt'},{send:'\r'},{wait:'READY'},{send:'quit\n'},{wait:'uncertain — process exited'}];

test('cold picker shows folder and global results without building a transcript cache',async t=>{
 const f=await setup();
 const [startup]=pty(f,[{wait:'Search:'},{wait:'codex  public source NEEDLE_SECRET'},...list,{send:'\x03'}]);
 assert.equal(startup.restored,true);
 await assert.rejects(access(join(f.state,'search')),{code:'ENOENT'});
 const [result]=pty(f,[...list,{send:'other-folder-only'},{wait:'No matching sessions.'},
  {send:'\t'},{wait:'Scope: global'},{wait:'codex  other-folder-only'},{send:'\x03'}]);
 assert.equal(result.restored,true);
});

test('main sessions hide subagents until opened by parent or enabled with F3',async t=>{
 const f=await setup();
 const spawn=(parent_thread_id,agent_nickname)=>({source:{subagent:{thread_spawn:{parent_thread_id,agent_nickname,agent_role:'worker'}}}});
 await writeRollout(f.codex,rollout(f.cwd,codexIds[3],[],spawn(codexIds[0],'Cedar')));
 await writeRollout(f.codex,rollout(f.other,codexIds[4],[],spawn(codexIds[0],'Willow')));
 await writeRollout(f.codex,rollout(f.cwd,codexIds[5],[],spawn(codexIds[9],'Orphan')));
 const [result]=pty(f,[...list,{send:'public source'},{wait:'Subagents  2'},
  {send:'\x1b[C'},{wait:'Subagents of'},{wait:'Cedar (worker)'},
  {send:'\x1b[D'},{wait:'Search: public source'},{wait:'Subagents  2'},{send:'\x15'},{wait:'Enter preview'},
  {send:'\x1bOR'},{wait:'Orphan (worker)'},{wait:'F3 hide subagents'},{send:'\x03'}]);
 const before=result.output.split('Subagents of')[0];
 assert.doesNotMatch(before,/Cedar \(worker\)|Willow \(worker\)|Orphan \(worker\)/);
 const branch=result.output.slice(result.output.indexOf('Subagents of'),result.output.lastIndexOf('Search: public source'));
 assert.match(branch,/Willow \(worker\)/);
 assert.doesNotMatch(branch,/Orphan \(worker\)/);
 assert.equal(result.restored,true);
});

for(const [source,target]of [['codex','claude'],['claude','codex']]) test(`real CLI ${source}→${target}: exact consented redacted payload, cwd, disclosure and unchanged native bytes`,async()=>{
 const f=await setup(target);
 // The review screen is scrolled to its end: a long archive folder makes the exact prompt taller than the screen.
 const actions=[...list,...select(source),...(target==='claude'?[{send:'\u001b[C'},{wait:'[claude]'}]:[]),...request,...redact,...finish.slice(0,2),{collectPreview:true},...finish.slice(2)];
 const [result]=pty(f,actions);
 assert.equal(result.code,0);assert.equal(result.restored,true);assert.equal(result.sampledWhileAlive,true);
 assert.match(result.output,/under its own account and data policies/);
 const launch=JSON.parse((await readFile(f.env.RUNTIME_LOG,'utf8')).trim());
 assert.equal(launch.cwd,await realpath(f.cwd));assert.deepEqual(launch.tty,[true,true,true]);
 const prompt=launch.args.at(-1);const parsed=JSON.parse(prompt);
 assert.equal(parsed.currentRequest,'Do next [REDACTED]');assert.equal(parsed.history.length,2);assert.match(parsed.history[0].text,/\[REDACTED\]/);assert.doesNotMatch(prompt,/NEEDLE_SECRET/);
 const begin=result.preview.indexOf('BEGIN EXACT PROMPT JSON STRING'),end=result.preview.indexOf('END EXACT PROMPT JSON STRING');
 assert.ok(begin>=0&&end>begin,'the review screen shows the whole encoded prompt');
 assert.equal(JSON.parse(result.preview.slice(begin+1,end).join('')),prompt,'target receives the exact previewed JSON');
 assert.deepEqual(await Promise.all(f.files.map(hash)),f.before);
 const records=JSON.parse(spawnSync(process.execPath,[join(repo,'dist/cli.js'),'transfers','list'],{env:{...process.env,...f.env},encoding:'utf8'}).stdout);
 assert.equal(records.length,1);assert.equal(records[0].state,'uncertain');assert.equal(records[0].targetNativeId,null);assert.equal(records[0].writer,'stopped');
 const transferFiles=async dir=>{for(const name of await readdir(dir)){const path=join(dir,name);if((await stat(path)).isDirectory())await transferFiles(path);else assert.equal((await readFile(path)).includes(Buffer.from('NEEDLE_SECRET')),false,path);}};
 await transferFiles(join(f.state,'transfers'));await transferFiles(join(f.state,'archives'));
});

test('same-agent resume receives native UUID plus only current request',async()=>{
 const f=await setup('codex');
 const [result]=pty(f,[...list,...select('codex'),...request,...redact,{send:'\r'},{wait:'Exact current request'},{send:'\r'},{wait:'READY'},{send:'quit\n'},{wait:'uncertain — process exited'}]);
 assert.equal(result.restored,true);
 const launch=JSON.parse((await readFile(f.env.RUNTIME_LOG,'utf8')).trim());
 assert.deepEqual(launch.args,['resume','-C',await realpath(f.cwd),'--',codexIds[0],'Do next [REDACTED]']);
 assert.deepEqual(await Promise.all(f.files.map(hash)),f.before);
});

test('cancelled final preview retains no transfer content and launches nothing',async()=>{
 const f=await setup();
 pty(f,[...list,...select('codex'),{send:'\u001b[C'},{wait:'[claude]'},...request,...redact,{send:'\r'},{wait:'Exact initial user prompt'},{send:'\u0003'}]);
 await assert.rejects(access(f.env.RUNTIME_LOG));
 assert.deepEqual((await readdir(join(f.state,'transfers'))).sort(),['attempts.sqlite','owner']);
 const {TransferJournal}=await import('../dist/transfer-journal.js');const journal=await TransferJournal.open(join(f.state,'transfers'));assert.equal(journal.list().length,0);journal.close();
 await assert.rejects(access(join(f.state,'archives')));
});

test('two real CLI processes choosing the same source admit exactly one launch',async()=>{
 const f=await setup();
 const toPreview=[...list,...select('codex'),{send:'\u001b[C'},{wait:'[claude]'},{send:'\r'},{wait:'Exact initial user prompt'}];
 const results=pty(f,[...toPreview,{start:true},...toPreview,{instance:0},{send:'\r'},{wait:'READY'},{instance:1},{send:'\r'},{wait:'failed before launch'},{instance:0},{send:'quit\n'},{wait:'uncertain — process exited'}]);
 assert.equal(results[0].code,0);assert.equal(results[1].code,1);
 const launches=(await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n');assert.equal(launches.length,1);
 const {TransferJournal}=await import('../dist/transfer-journal.js');const journal=await TransferJournal.open(join(f.state,'transfers'));assert.deepEqual(journal.list().map(record=>record.state).sort(),['failed','uncertain']);journal.close();
});

for(const phase of ['committed-first','ready-first','pre-pid'])test(`wrapper death ${phase==='pre-pid'?'before durable child PID':'after READY ('+phase+')'} leaves source and live archive protected on restart`,async t=>{
 const gap=phase==='pre-pid';
 const f=await setup();f.env.CLI_CHILD_HEARTBEAT=join(f.root,'child-heartbeat');t.after(()=>stopHeartbeatChild(f.env.CLI_CHILD_HEARTBEAT));f.env.CLI_TRACK_PID_COMMIT='1';if(phase==='ready-first')f.env.CLI_DELAY_PID_COMMIT='1';if(phase==='committed-first')f.env.RUNTIME_READY_DELAY_MS='150';if(gap){f.env.CLI_CRASH_POINT='spawn-before-pid';f.env.RUNTIME_READY_DELAY_MS='100';}
 const first=[...list,...select('codex'),{send:'\u001b[C'},{wait:'[claude]'},{send:'\r'},{wait:'Exact initial user prompt'},{send:'\r'},{wait:'READY'},...(gap?[{waitPrePidBarrier:true}]:[{waitPostPidCommit:true}]),{assertWrapperAlive:true},{killWrapper:true}];
 // A later wrapper reads the same native source. Ownership cannot be stolen even
 // when the original parent is dead and the target PID was never committed.
 const result=pty(f,[...first,{assertLiveChild:true},{start:true},...list,...select('codex'),{send:'\r'},{wait:'ownership is unknown'},{send:'\u0003'},{assertLiveChild:true}]);
 assert.equal(result[0].code,-9,'the driver must SIGKILL the live wrapper explicitly');
 const {TransferJournal}=await import('../dist/transfer-journal.js');const journal=await TransferJournal.open(join(f.state,'transfers'));const [record]=journal.list();
 assert.equal(record.state,'pending');assert.equal(record.writer,'unknown');assert.equal(record.childPid===null,gap);assert.equal(journal.ownerState(record.sourceKey),'unknown');
 assert.throws(()=>journal.beginDeletion(record.id),/writer/);journal.abort(record.id);assert.equal(journal.get(record.id).state,'pending');
 const {deleteArchive}=await import('../dist/archive.js');await assert.rejects(deleteArchive(record.archive),/reserved/);journal.close();
 const launches=(await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(launches.length,1);assert.equal(record.childPid,gap?null:launches[0].pid);
 if(!gap)assert.match(result[0].output,/PID_COMMIT_DONE/);
});

test('deliberate recovery is a new confirmed fresh attempt; abort/delete removes only that transfer content',async()=>{
 const f=await setup();pty(f,[...list,...select('codex'),{send:'\u001b[C'},{wait:'[claude]'},...redact,...finish]);
 const {TransferJournal}=await import('../dist/transfer-journal.js');let journal=await TransferJournal.open(join(f.state,'transfers'));const [prior]=journal.list();journal.close();
 const results=pty(f,[...list,{send:'\r'},{wait:'Enter choose target'},{send:'\r'},{wait:'C edit request'},{send:'\u001b[C'},{wait:'[claude]'},{send:'\r'},{wait:'Earlier delivery: uncertain'},{send:'\r'},{wait:'READY'},{send:'quit\n'},{wait:'uncertain — process exited'}],['transfers','retry',prior.id]);
 assert.equal(results[0].code,0);journal=await TransferJournal.open(join(f.state,'transfers'));const records=journal.list();assert.equal(records.length,2);assert.equal(records[0].retryOf,prior.id);assert.notEqual(records[0].id,prior.id);journal.close();
 const cli=(...args)=>spawnSync(process.execPath,[join(repo,'dist/cli.js'),...args],{env:{...process.env,...f.env},encoding:'utf8'});
 assert.equal(cli('transfers','abort',prior.id).status,0);const deleted=cli('transfers','delete',prior.id);assert.equal(deleted.status,0,deleted.stderr);
 await assert.rejects(access(join(prior.archive.directory,prior.archive.id+'.json')));
 journal=await TransferJournal.open(join(f.state,'transfers'));assert.equal(journal.get(prior.id).deleted,true);assert.equal(journal.get(prior.id).prompt,undefined);assert.equal(journal.ownerState(prior.sourceKey),'idle');journal.close();
});

test('real picker folder scope is exact; global message search defaults to the recorded source workspace',async()=>{
 const f=await setup();
 const [result]=pty(f,[...list,{send:'other-folder-only'},{wait:'Enter preview'},{send:'\t'},{wait:'Enter preview'},{send:'\r'},{wait:'Enter choose target'},{send:'\r'},{wait:'C edit request'},{send:'\u001b[C'},{wait:'[claude]'},...finish]);
 const launch=JSON.parse((await readFile(f.env.RUNTIME_LOG,'utf8')).trim());assert.equal(launch.cwd,await realpath(f.other));
 const initial=result.output.slice(0,result.output.indexOf('other-folder-only'));assert.ok(!initial.includes(codexIds[1]));assert.ok(!initial.includes(codexIds[2]));
 assert.match(result.output,/No matching sessions/);assert.match(result.output,/Scope: global/);assert.equal(JSON.parse(launch.args.at(-1)).history[0].text,'other-folder-only');
});

test('source filter and missing recorded workspace require an explicit valid override',async()=>{
 const f=await setup('codex');const missing=join(f.root,'missing-workspace');
 await writeRollout(f.codex,rollout(missing,codexIds[3],[completed('UserMessage','u','missing source workspace',1)]));
 const [result]=pty(f,[...list,{send:'\u001b[C'},{wait:'Enter preview'},{send:'\t'},{wait:'Enter preview'},{send:'missing source workspace'},{wait:'Enter preview'},{send:'\r'},{wait:'Enter choose target'},{send:'\r'},{wait:'C edit request'},{send:'\r'},{wait:'Workspace unavailable:'},{send:'w'},{wait:'Explicit workspace override'},{send:f.cwd+'\r'},{wait:'Exact current request'},{send:'\r'},{wait:'READY'},{send:'quit\n'},{wait:'uncertain — process exited'}]);
 assert.match(result.output,/Agent: codex/);const launch=JSON.parse((await readFile(f.env.RUNTIME_LOG,'utf8')).trim());assert.equal(launch.cwd,await realpath(f.cwd));assert.ok(launch.args.includes(codexIds[3]));
});

test('changed executable after preview fails before spawn and retains the consented redacted recovery record',async()=>{
 const f=await setup();
 const [result]=pty(f,[...list,...select('codex'),{send:'\u001b[C'},{wait:'[claude]'},...redact,{send:'\r'},{wait:'Exact initial user prompt'},{append:{path:join(f.root,'bin','claude'),text:'\n// synthetic executable replacement\n'}},{send:'\r'},{wait:'failed before launch'}]);
 assert.equal(result.code,1);await assert.rejects(access(f.env.RUNTIME_LOG));
 const {TransferJournal}=await import('../dist/transfer-journal.js');const journal=await TransferJournal.open(join(f.state,'transfers'));const [record]=journal.list();assert.equal(record.state,'failed');assert.equal(record.launch,'not-launched');assert.equal(journal.ownerState(record.sourceKey),'idle');journal.close();
});

test('changed source invalidates preview without publishing a transfer; cache purge is separate',async()=>{
 const f=await setup();const [result]=pty(f,[...list,...select('codex'),{send:'\u001b[C'},{wait:'[claude]'},...redact,{send:'\r'},{wait:'Exact initial user prompt'},{append:{path:f.files[0],text:'{partial'}},{send:'\r'},{wait:'Source changed after preview'}]);
 assert.equal(result.code,1);await assert.rejects(access(f.env.RUNTIME_LOG));await assert.rejects(access(join(f.state,'archives')));
 const resultPurge=spawnSync(process.execPath,[join(repo,'dist/cli.js'),'cache','purge'],{env:{...process.env,...f.env},encoding:'utf8'});assert.equal(resultPurge.status,0,resultPurge.stderr);await assert.rejects(access(join(f.state,'search')));assert.ok((await readFile(f.files[0],'utf8')).includes('NEEDLE_SECRET'));
});


// Version table: test/native-catalog.test.mjs. These runs prove an untested producer reaches a native launch.
for(const {agent,file,id,from,to,label} of [{agent:'codex',file:0,id:codexIds[0],from:'0.171.0',to:'0.172.0',label:'0.172.0'},{agent:'claude',file:3,id:claudeIds[0],from:'2.1.330',to:'2.1.331',label:'2.1.331'},{agent:'claude',file:3,id:claudeIds[0],from:',"version":"2.1.330"',to:'',label:'without a version'}])test(`untested ${agent} producer ${label} resumes natively by exact ID`,async()=>{
 const f=await setup(agent),original=await readFile(f.files[file],'utf8');assert.ok(original.includes(from));await writeFile(f.files[file],original.replaceAll(from,to));
 const [result]=pty(f,[...list,...select(agent),...(agent==='claude'?[{send:'\u001b[C'},{wait:'[claude]'}]:[]),{wait:`Resumes the original ${agent} session natively.`},...request,{send:'\r'},{wait:'Exact current request'},{send:'\r'},{wait:'READY'},{send:'quit\n'},{wait:'uncertain — process exited'}]);
 assert.equal(result.restored,true);assert.match(result.output,/Mode  native resume/);
 const launch=JSON.parse((await readFile(f.env.RUNTIME_LOG,'utf8')).trim());
 assert.ok(launch.args.some(arg=>arg.includes(id)),JSON.stringify(launch.args));assert.equal(launch.args.at(-1),'Do next NEEDLE_SECRET');
});
test('supervised native exit releases only writer ownership; intentional selection can resume again',async()=>{
 const f=await setup('codex');
 const actions=[...list,...select('codex'),{send:'\r'},{wait:'Exact current request'},{send:'\r'},{wait:'READY'},{send:'quit\n'},{wait:'uncertain — process exited'}];
 pty(f,actions);pty(f,actions);
 const launches=(await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(launches.length,2);assert.ok(launches.every(launch=>launch.args[0]==='resume'&&launch.args.includes(codexIds[0])));
 const {TransferJournal}=await import('../dist/transfer-journal.js');const journal=await TransferJournal.open(join(f.state,'transfers'));assert.equal(journal.list().length,2);assert.ok(journal.list().every(record=>record.state==='uncertain'&&record.writer==='stopped'));assert.equal(journal.ownerState(journal.list()[0].sourceKey),'idle');journal.close();
});

test('bounded final preview explains omissions and exposes the retained redacted tool/user archive',async()=>{
 const f=await setup();
 await writeRollout(f.codex,rollout(f.cwd,codexIds[0],[completed('UserMessage','u','public source NEEDLE_SECRET '+('huge '.repeat(4500)),1),completed('AgentMessage','a','intact selected answer',2),completed('CommandExecution','t','tool outcome NEEDLE_SECRET',3)]));
 const [result]=pty(f,[...list,...select('codex'),{send:'\u001b[C'},{wait:'[claude]'},...redact,...finish]);
 const launch=JSON.parse((await readFile(f.env.RUNTIME_LOG,'utf8')).trim());const prompt=JSON.parse(launch.args.at(-1));assert.equal(prompt.omissions.count,1);assert.ok(prompt.history.some(item=>item.role==='tool'&&item.text==='tool outcome [REDACTED]'));assert.match(result.output,/Omitted IDs  [a-f0-9]{64}/);
 const {TransferJournal}=await import('../dist/transfer-journal.js');const journal=await TransferJournal.open(join(f.state,'transfers'));const [record]=journal.list();journal.close();
 const cli=(...args)=>spawnSync(process.execPath,[join(repo,'dist/cli.js'),'archive',...args],{encoding:'utf8',env:{...process.env,...f.env}});
 const manifest=cli('list','--directory',record.archive.directory,'--archive',record.archive.id);assert.equal(manifest.status,0,manifest.stderr);const page=JSON.parse(manifest.stdout);assert.equal(page.items.length,3);assert.equal(page.items[0].included,false);
 const text=cli('read','--directory',record.archive.directory,'--archive',record.archive.id,'--item','0');assert.equal(text.status,0,text.stderr);assert.match(JSON.parse(text.stdout).text,/public source \[REDACTED\]/);assert.doesNotMatch(text.stdout,/NEEDLE_SECRET/);
});

test('fresh retry of a native-resume attempt rereads source history and never silently loses context',async()=>{
 const f=await setup('codex');pty(f,[...list,...select('codex'),...request,...redact,{send:'\r'},{wait:'Exact current request'},{send:'\r'},{wait:'READY'},{send:'quit\n'},{wait:'uncertain — process exited'}]);
 const {TransferJournal}=await import('../dist/transfer-journal.js');const journal=await TransferJournal.open(join(f.state,'transfers'));const [prior]=journal.list();journal.close();
 pty(f,[...list,{send:'\r'},{wait:'Enter choose target'},{send:'\r'},{wait:'C edit request'},...redact,{send:'\r'},{wait:'Exact initial user prompt'},{send:'\r'},{wait:'READY'},{send:'quit\n'},{wait:'uncertain — process exited'}],['transfers','retry',prior.id]);
 const launches=(await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(launches.length,2);assert.equal(launches[1].args[0],'-C');const prompt=JSON.parse(launches[1].args.at(-1));assert.equal(prompt.history.length,2);assert.equal(prompt.currentRequest,'Do next [REDACTED]');assert.doesNotMatch(launches[1].args.at(-1),/NEEDLE_SECRET/);
});


test('T4: an archive expired at startup leaves the attempt in the journal, and F recovery rereads the active source',async t=>{
 const f=await setup();
 pty(f,[...list,...select('codex'),{send:'\u001b[C'},{wait:'[claude]'},...finish]);
 const {TransferJournal}=await import('../dist/transfer-journal.js');let journal=await TransferJournal.open(join(f.state,'transfers'));const [prior]=journal.list();journal.close();
 const archive=join(prior.archive.directory,prior.archive.id+'.json');const old=new Date(Date.now()-31*86400000);await utimes(archive,old,old);
 await writeRollout(f.codex,rollout(f.cwd,codexIds[0],[completed('UserMessage','u','public source NEEDLE_SECRET',1),completed('AgentMessage','a','public answer',2),completed('UserMessage','u2','turn after the archive',3)]));
 pty(f,[...list,{send:'\r'},{wait:'Enter choose target'},{send:'\r'},{wait:'C edit request'},{send:'\u001b[C'},{wait:'[claude]'},{send:'\r'},{wait:'Earlier delivery: uncertain'},{send:'\r'},{wait:'READY'},{send:'quit\n'},{wait:'uncertain — process exited'}],['transfers','retry',prior.id]);
 await assert.rejects(access(archive),{code:'ENOENT'});
 journal=await TransferJournal.open(join(f.state,'transfers'));const [retry,expired]=journal.list();journal.close();
 assert.equal(retry.retryOf,prior.id);assert.match(expired.archiveExpiredAt,/^\d{4}-\d\d-\d\dT/);assert.deepEqual(expired.archive,prior.archive);assert.equal(expired.prompt,prior.prompt);
 const launches=(await readFile(f.env.RUNTIME_LOG,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(launches.length,2);
 assert.deepEqual(JSON.parse(launches[1].args.at(-1)).history.map(item=>item.text),['public source NEEDLE_SECRET','public answer','turn after the archive']);
});

test('80-column exact preview reconstructs every wire byte with 400 emoji and safely escaped C1 controls',async()=>{
 const f=await setup();
 const original='public source VISIBLE_A\u0085VISIBLE_B '+('😀'.repeat(400))+' literal \\u0085 and escape \u001b[31m Žluťoučký 日本語 \u202e\u200e';
 await writeRollout(f.codex,rollout(f.cwd,codexIds[0],[completed('UserMessage','u',original,1)]));
 const [result]=pty(f,[...list,...select('codex'),{send:'\u001b[C'},{wait:'[claude]'},{send:'\r'},{wait:'Mode  fresh handoff'},{collectPreview:true},{send:'\r'},{wait:'READY'},{send:'quit\n'},{wait:'uncertain — process exited'}],[],{columns:80,rows:24});
 const launch=JSON.parse((await readFile(f.env.RUNTIME_LOG,'utf8')).trim());const wire=launch.args.at(-1);
 const begin=result.preview.indexOf('BEGIN EXACT PROMPT JSON STRING'),end=result.preview.indexOf('END EXACT PROMPT JSON STRING');
 assert.ok(begin>=0&&end>begin,'the complete encoded prompt must be scrollable through its end marker');
 const encoded=result.preview.slice(begin+1,end).join('');
 assert.equal(JSON.parse(encoded),wire);assert.match(encoded,/Žluťoučký 日本語/u);assert.doesNotMatch(result.output,/\x1b\[31m|\p{Bidi_Control}/u);assert.equal(JSON.parse(wire).history[0].text,original);
 assert.equal((JSON.parse(encoded).match(/😀/gu)??[]).length,400);assert.ok(encoded.includes('\\u0085'));assert.doesNotMatch(encoded,/[\x00-\x1f\x7f-\x9f]/u);assert.doesNotMatch(result.output,/\u0085|\ufffd/u);
 assert.ok(result.preview.every(row=>row.length<=79),'encoded preview rows fit the actual terminal width');
});


test('native selection through a true workspace alias launches in its canonical directory',async()=>{
 const f=await setup('codex');const originalWorkspace=f.cwd;const alias=join(f.root,'workspace-alias');await symlink(originalWorkspace,alias,'dir');f.cwd=alias;
 pty(f,[...list,...select('codex'),{send:'\r'},{wait:'Exact current request'},{send:'\r'},{wait:'READY'},{send:'quit\n'},{wait:'uncertain — process exited'}]);
 const launch=JSON.parse((await readFile(f.env.RUNTIME_LOG,'utf8')).trim());assert.equal(launch.cwd,await realpath(alias));assert.notEqual(launch.cwd,alias);assert.equal(launch.args[2],await realpath(originalWorkspace));
});
