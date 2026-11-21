import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, RuntimeError, createOwnedSessionGuard } from '../dist/runtime.js';
const uuid='12345678-1234-1234-1234-123456789abc';
const source={id:'source',nativeId:uuid,agent:'codex'};
const fake=String.raw`#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args=process.argv.slice(2);const provider=process.argv[1].includes('claude')?'claude':'codex';
appendFileSync(process.env.FAKE_LOG,JSON.stringify({args,cwd:process.cwd(),tty:[process.stdin.isTTY===true,process.stdout.isTTY===true,process.stderr.isTTY===true]})+'\n');
if(args.includes('--version'))console.log(process.env.FAKE_VERSION||(provider==='codex'?'codex-cli 0.171.0':'2.1.330 (Claude Code)'));
else if(args.includes('--help')){
 if(process.env.FAKE_HELP==='timeout')setTimeout(()=>{},10000);
 else if(process.env.FAKE_HELP==='huge')console.log('x'.repeat(100000));
 else if(process.env.FAKE_HELP==='bad')console.log('unsupported');
 else if(process.env.FAKE_HELP==='nonzero')process.exit(2);
 else if(provider==='codex')console.log(args[0]==='resume'?'Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]\n  -C, --cd <DIR>':'Usage: codex [OPTIONS] [PROMPT]\n  resume\n  -C, --cd <DIR>');
 else console.log('Usage: claude [options] [prompt]\n  -r, --resume [value]');
}else {console.error('synthetic native diagnostic');process.exit(Number(process.env.FAKE_EXIT||0));}
`;
async function fixture(t,extra={}){
 const root=realpathSync(await mkdtemp(join(tmpdir(),'agentswitch-runtime-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const workspace=join(root,'workspace $() spaces');await mkdir(workspace);const log=join(root,'events');await writeFile(log,'');
 const executables={codex:join(root,'codex.mjs'),claude:join(root,'claude.mjs')};
 for(const file of Object.values(executables))await writeFile(file,fake,{mode:0o700});
 const env={...process.env,FAKE_LOG:log,...extra};
 const guard=createOwnedSessionGuard();
 const runtime=createRuntime({executables,env,guard,probeTimeoutMs:extra.FAKE_HELP==='timeout'?200:2000,getSource:async()=>({...source,workspace,nativeResume:'compatible'})});
 const request={source,target:'codex',workspace:{kind:'source',path:workspace}};
 return {root,workspace,executables,log,env,guard,runtime,request,events:async()=> (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)};
}
test('exact native IDs and safe provider-specific argument boundaries',async t=>{
 const f=await fixture(t);const prepared=await f.runtime.prepare(f.request,{currentRequest:'--request $(touch nope)'});
 assert.equal(prepared.summary.mode,'native-resume');assert.deepEqual(prepared.plan.args,['resume','-C',f.workspace,'--',uuid,'--request $(touch nope)']);
 const cross=await f.runtime.prepare({...f.request,target:'claude'},{handoff:{prompt:'history\ncurrent request',includedItemIds:['a'],omittedItemIds:['b']}});
 assert.deepEqual(cross.plan.args,['--','history\ncurrent request']);assert.equal(cross.summary.mode,'fresh-handoff');assert.deepEqual(cross.summary.includedItemIds,['a']);
 const claudeSource={...source,agent:'claude'};
 const runtime=createRuntime({executables:f.executables,env:f.env,getSource:async()=>({...claudeSource,workspace:f.workspace,nativeResume:'compatible'})});
 const p=await runtime.prepare({...f.request,source:claudeSource,target:'claude'},{currentRequest:'-literal'});
 assert.deepEqual(p.plan.args,[`--resume=${uuid}`,'--','-literal']);
});
test('complete UTF-8 positional prompt is bounded with no truncation',async t=>{
 const f=await fixture(t);const prepare=prompt=>f.runtime.prepare({...f.request,target:'claude'},{handoff:{prompt,includedItemIds:[],omittedItemIds:[]}});
 const exact='é'.repeat(8192);assert.equal((await prepare(exact)).plan.args[1],exact);
 await assert.rejects(prepare(exact+'!'),e=>e instanceof RuntimeError&&e.code==='PROMPT_TOO_LARGE');
 await assert.rejects(prepare('NUL\0secret'),/NUL/);
 await assert.rejects(f.runtime.prepare(f.request,{currentRequest:'x'.repeat(16385)}),/byte/);
});
for(const env of [{FAKE_VERSION:'codex-cli 0.172.0'},{FAKE_VERSION:'garbage'},{FAKE_HELP:'bad'},{FAKE_HELP:'huge'},{FAKE_HELP:'timeout'},{FAKE_HELP:'nonzero'}])test(`capabilities reject ${JSON.stringify(env)} before launch`,async t=>{
 const f=await fixture(t,env);await assert.rejects(f.runtime.prepare(f.request),RuntimeError);assert.ok((await f.events()).every(e=>e.args.includes('--version')||e.args.includes('--help')));
});
test('source identity, trusted workspace and native compatibility cannot be overridden by choice labels',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.runtime.prepare({...f.request,workspace:{kind:'source',path:f.root}}),/recorded/);
 for(const nativeId of ['--last','','../../name','bad\0id'])await assert.rejects(f.runtime.prepare({...f.request,source:{...source,nativeId}}),/identity|UUID/);
 const incompatible=createRuntime({executables:f.executables,env:f.env,getSource:async()=>({...source,workspace:f.workspace,nativeResume:'incompatible'})});
 await assert.rejects(incompatible.prepare(f.request),/fresh/);
 const p=await f.runtime.prepare({...f.request,workspace:{kind:'override',path:f.root}});assert.equal(p.summary.workspace,f.root);
});
test('ownership is checked at prepare and acquired atomically again at launch',async t=>{
 const f=await fixture(t);const release=f.guard.acquire(source);await assert.rejects(f.runtime.prepare(f.request),/active/);release();
 const p=await f.runtime.prepare(f.request);const late=f.guard.acquire(source);await assert.rejects(f.runtime.launch(p.plan),/active/);late();
 const unknown=createRuntime({executables:f.executables,env:f.env,guard:{check:()=> 'unknown',acquire:()=>{throw Error('unexpected');}},getSource:async()=>({...source,workspace:f.workspace,nativeResume:'compatible'})});
 await assert.rejects(unknown.prepare(f.request),/unknown/);
});
test('launch revalidates cwd and executable and cancellation prevents dispatch',async t=>{
 const f=await fixture(t);const p=await f.runtime.prepare(f.request);await rm(f.workspace,{recursive:true});await assert.rejects(f.runtime.launch(p.plan),/Workspace/);
 await mkdir(f.workspace);await writeFile(f.executables.codex,fake+'\n// changed');await assert.rejects(f.runtime.launch(p.plan),/changed/);
 const p2=await f.runtime.prepare(f.request);const abort=new AbortController();abort.abort();await assert.rejects(f.runtime.launch(p2.plan,{signal:abort.signal}),/cancel/i);
 await chmod(f.executables.claude,0o600);await assert.rejects(f.runtime.prepare({...f.request,target:'claude'},{handoff:{prompt:'hello',includedItemIds:[],omittedItemIds:[]}}),/executable/);
});
test('prepared plans are frozen snapshots and unrecognized plans are refused',async t=>{
 const f=await fixture(t);const p=await f.runtime.prepare(f.request);assert.equal(Object.isFrozen(p.plan),true);assert.equal(Object.isFrozen(p.plan.args),true);
 await assert.rejects(f.runtime.launch({...p.plan}),/prepared/);
});

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
const terminalRun=async(t,scenario,actions,extra={})=>{
 const f=await fixture(t);const executable=realpathSync('test/fixtures/runtime-child.mjs');
 const r=spawnSync('python3',['test/fixtures/drive-runtime.py'],{input:JSON.stringify({env:{RUNTIME_WORKSPACE:f.workspace,RUNTIME_EXECUTABLE:executable,RUNTIME_LOG:f.log,RUNTIME_SCENARIO:scenario,...extra},actions}),encoding:'utf8',timeout:15000});
 assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.code,0,result.output);assert.equal(result.restored,true,result.output);assert.equal(result.sampledWhileAlive,true,'termios must be sampled while the controlling session leader is alive');
 const done=JSON.parse(result.output.match(/DONE (.*)\r?\n/)[1]);assert.deepEqual(done.before,done.after);assert.equal(done.calls,1);
 assert.match(result.output,/DISPATCH \{"raw":false,"calls":1\}/);if(!['spawn-error','cancel-acquire'].includes(scenario))assert.match(result.output,/RETRY INVALID_PLAN/);
 if(['spawn-error','cancel-acquire'].includes(scenario)){assert.match(result.output,scenario==='spawn-error'?/EXPECTED_ERROR LAUNCH_FAILED/:/EXPECTED_ERROR CANCELLED/);assert.match(result.output,/RELEASE/);assert.equal((await f.events()).length,0);return {result};}
 const receipt=JSON.parse(result.output.match(/RESULT (.*)\r?\n/)[1]);assert.equal(receipt.launched,true);assert.equal(receipt.consumption,'unknown');
 await assert.rejects(access(join(f.workspace,'sentinel')),{code:'ENOENT'});
 const launches=await f.events();assert.equal(launches.length,1);assert.deepEqual(launches[0].tty,[true,true,true]);assert.equal(launches[0].cwd,realpathSync(f.workspace));
 if(extra.RUNTIME_TARGET==='claude')assert.deepEqual(launches[0].args,extra.RUNTIME_SOURCE==='claude'?[`--resume=${uuid}`,'--','--literal $(touch sentinel); `echo unsafe` "quotes"']:['--','Historical user context\nCurrent request: --literal $(touch sentinel)']);
 else assert.deepEqual(launches[0].args,['resume','-C',realpathSync(f.workspace),'--',uuid,'--literal $(touch sentinel); `echo unsafe` "quotes"']);
 if(extra.RUNTIME_TARGET!=='claude'||extra.RUNTIME_SOURCE==='claude'){assert.match(result.output,/LEASE active/);assert.match(result.output,/RELEASE idle/);}
 return {result,receipt};
};
test('PTY picker transfers usable inherited terminal, exact literal argv, resize and exit0',async t=>{
 const {result,receipt}=await terminalRun(t,'interactive',[{wait:'READY'},{send:'hello\n'},{wait:'INPUT "hello\\n"'},{resize:true},{wait:'RESIZED'},{send:'quit\n'}]);
 assert.equal(receipt.code,0);assert.equal(receipt.signal,null);assert.match(result.output,/"raw":false/);
});
for(const [scenario,code,signal] of [['exit7',7,null],['auth',1,null],['self-signal',null,'SIGTERM']])test(`PTY preserves ${scenario} status and diagnostic`,async t=>{
 const {result,receipt}=await terminalRun(t,scenario,[]);assert.equal(receipt.code,code);assert.equal(receipt.signal,signal);assert.match(receipt.recovery,/native diagnostic/);
 if(scenario==='auth')assert.match(result.output,/SYNTHETIC AUTH REFUSAL/);
});
for(const signal of ['SIGINT','SIGTERM'])test(`PTY forwards parent-only ${signal} and restores child raw mode`,async t=>{
 const {receipt}=await terminalRun(t,'raw',[{wait:'READY'},{signal}]);assert.equal(receipt.code,null);assert.equal(receipt.signal,signal);
});
test('foreground terminal Ctrl+C reaches fake child and wrapper cleans up',async t=>{
 const {receipt}=await terminalRun(t,'interactive',[{wait:'READY'},{send:'\x03'}]);assert.equal(receipt.code,null);assert.equal(receipt.signal,'SIGINT');
});

for(const native of [false,true])test(`PTY Claude ${native?'native resume':'fresh handoff'} uses its own argv and inherited terminal`,async t=>{
 const {receipt}=await terminalRun(t,'interactive',[{wait:'READY'},{send:'quit\n'}],{RUNTIME_TARGET:'claude',...(native?{RUNTIME_SOURCE:'claude'}:{})});assert.equal(receipt.code,0);
});
for(const scenario of ['spawn-error','cancel-acquire'])test(`PTY ${scenario} releases acquired lease without launching`,async t=>{
 // Use a private executable because this fixture deliberately changes its mode.
 const f=await fixture(t);const file=join(f.root,'runtime-child.mjs');await writeFile(file,await readFile('test/fixtures/runtime-child.mjs'),{mode:0o700});
 await terminalRun(t,scenario,[],{RUNTIME_EXECUTABLE:file});
});

test('missing source/override workspaces and binaries fail without fallback or launch',async t=>{
 const f=await fixture(t);await assert.rejects(f.runtime.prepare({...f.request,workspace:{kind:'override',path:join(f.root,'missing')}}),/Workspace/);
 await rm(f.executables.codex);await assert.rejects(f.runtime.prepare(f.request),/executable/);assert.deepEqual(await f.events(),[]);
});
test('trusted invalid native IDs, incompatible source kinds and explicit fresh recovery',async t=>{
 const f=await fixture(t);
 for(const nativeId of ['--last','../../file','',uuid+'\0']){
  const invalid={...source,nativeId};const runtime=createRuntime({executables:f.executables,env:f.env,getSource:async()=>({...invalid,workspace:f.workspace,nativeResume:'compatible'})});
  await assert.rejects(runtime.prepare({...f.request,source:invalid}),/UUID/);
 }
 const runtime=createRuntime({executables:f.executables,env:f.env,getSource:async()=>({...source,workspace:f.workspace,nativeResume:'unknown'})});
 await assert.rejects(runtime.prepare(f.request),/fresh/);
 const recovered=await runtime.prepare(f.request,{mode:'fresh',handoff:{prompt:'Prepared historical context; current request',includedItemIds:['a'],omittedItemIds:[]}});assert.equal(recovered.plan.mode,'fresh-handoff');assert.deepEqual(recovered.plan.args,['-C',f.workspace,'--','Prepared historical context; current request']);
});
test('cancelled preparation and mid-probe abort cannot launch',async t=>{
 const f=await fixture(t,{FAKE_HELP:'timeout'});const cancelled=new AbortController();cancelled.abort();await assert.rejects(f.runtime.prepare(f.request,{},cancelled.signal),/cancel/i);assert.deepEqual(await f.events(),[]);
 const pending=new AbortController();const running=f.runtime.prepare(f.request,{},pending.signal);setTimeout(()=>pending.abort(),50);await assert.rejects(running,/cancel/i);assert.ok((await f.events()).every(e=>e.args.includes('--version')||e.args.includes('--help')));
});

test('PTY refuses a second distinct plan while the terminal already belongs to a child',async t=>{
 const {result}=await terminalRun(t,'overlap',[]);assert.match(result.output,/OVERLAP TERMINAL_BUSY/);
});
