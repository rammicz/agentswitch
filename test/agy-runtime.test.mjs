import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,writeFile,readFile,realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime,createOwnedSessionGuard } from '../dist/runtime.js';
import { tempDir } from './fixtures/temp.mjs';
const id='12345678-1234-1234-1234-123456789abc';
async function fixture(t,extra={}) {
 const root=await realpath(await tempDir('agentswitch-agy-runtime-'));const cwd=join(root,'workspace'),bin=join(root,'agy.mjs');await mkdir(cwd);
 const help=JSON.parse(await readFile('test/fixtures/agy/help.json','utf8')).stderr;
 await writeFile(bin,`#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]==='--version')console.log(process.env.AGY_FAKE_VERSION||'1.5.14');else if(args[0]==='--help')console.error(process.env.AGY_FAKE_HELP||${JSON.stringify(help)});else throw Error('unexpected launch');\n`,{mode:0o700});
 const source={id:'agy:'+id,nativeId:id,agent:'agy'},guard=createOwnedSessionGuard();const runtime=createRuntime({executables:{agy:bin},env:{...process.env,...extra},guard,getSource:async()=>({...source,workspace:cwd,nativeResume:'compatible'})});return {root,cwd,bin,source,guard,runtime,request:{source,target:'agy',workspace:{kind:'source',path:cwd}}};
}
test('agy exact native open sends no request or history and requires recorded cwd/empty draft',async t=>{
 const f=await fixture(t);const p=await f.runtime.prepare(f.request,{currentRequest:''});assert.deepEqual(p.plan.args,['--conversation',id]);assert.equal(p.plan.version,'1.5.14');assert.equal(p.plan.observer,'none');
 await assert.rejects(f.runtime.prepare(f.request,{currentRequest:'new request'}),/Clear the request explicitly/);
 await assert.rejects(f.runtime.prepare(f.request,{currentRequest:'',handoff:{prompt:'history',includedItemIds:[],omittedItemIds:[]}}),/initial request/);
 await assert.rejects(f.runtime.prepare({...f.request,workspace:{kind:'override',path:f.root}},{currentRequest:''}),/recorded workspace/);
 const release=f.guard.acquire(f.source);await assert.rejects(f.runtime.prepare(f.request,{currentRequest:''}),/active/);release();
});
test('agy fresh literal argument is bounded, uses interactive transport, never shell flags',async t=>{
 const f=await fixture(t);const prompt='--literal $(touch sentinel); `echo no` "quotes"\nnext';const handoff={prompt,includedItemIds:['a'],omittedItemIds:['b']};const p=await f.runtime.prepare(f.request,{mode:'fresh',handoff});assert.deepEqual(p.plan.args,['--prompt-interactive',prompt]);assert.equal(p.summary.mode,'fresh-handoff');
 const exact='é'.repeat(8192);assert.equal((await f.runtime.prepare(f.request,{mode:'fresh',handoff:{...handoff,prompt:exact}})).plan.args[1],exact);
 for(const prompt of ['x'.repeat(16385),'bad\0value'])await assert.rejects(f.runtime.prepare(f.request,{mode:'fresh',handoff:{...handoff,prompt}}),/byte|NUL/);
 const abort=new AbortController();abort.abort();await assert.rejects(f.runtime.launch(p.plan,{signal:abort.signal}),/cancel/i);
});
test('agy native open with help lacking --conversation cannot prepare',async t=>{
 const f=await fixture(t,{AGY_FAKE_HELP:'Usage of agy:\n --prompt-interactive only'});await assert.rejects(f.runtime.prepare(f.request,{currentRequest:''}),e=>e.code==='UNSUPPORTED_CAPABILITY');
});
test('agy native open refuses unknown compatibility and unknown owner without guessing',async t=>{
 const f=await fixture(t);for(const nativeResume of ['unknown','incompatible']) {
  const runtime=createRuntime({getSource:async()=>({...f.source,workspace:f.cwd,nativeResume})});await assert.rejects(runtime.prepare(f.request,{currentRequest:''}),e=>e.code==='INCOMPATIBLE_NATIVE');
 }
 const runtime=createRuntime({guard:{check:()=> 'unknown',acquire:()=>{throw Error('unexpected');}},getSource:async()=>({...f.source,workspace:f.cwd,nativeResume:'compatible'})});await assert.rejects(runtime.prepare(f.request,{currentRequest:''}),e=>e.code==='UNKNOWN_OWNER');
});
