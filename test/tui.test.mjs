import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root=mkdtempSync(join(tmpdir(),'agentswitch-picker-'));
const other=join(root,'other');mkdirSync(other);
process.on('exit',()=>rmSync(root,{recursive:true,force:true}));
const run=(actions,scenario='',extra={})=>{
 const p=spawnSync('python3',['test/fixtures/drive-terminal.py'],{input:JSON.stringify({env:{PICKER_WORKSPACE:root,PICKER_OTHER:other,PICKER_SCENARIO:scenario,...extra},actions,...(scenario==='query-error'?{initial:'offline query failed'}:{})}),encoding:'utf8',timeout:15000});
 assert.equal(p.status,0,p.stderr);const result=JSON.parse(p.stdout);assert.equal(result.restored,true,result.output);
 const done=result.output.match(/DONE (.*)\r?\n/);if(done){const state=JSON.parse(done[1]);assert.deepEqual(state.listeners,state.before);}assert.match(result.output,/\x1b\[\?25h\x1b\[\?1049l/);return result;
};
const key=(send,wait)=>({send,wait});
test('production picker confirms exact prepared plan after terminal cleanup',()=>{
 const r=run([key('\r','Public transcript'),key('\r','Target:'),key('\x1b[C','Target: claude'),key('\r','Mode: fresh-handoff'),key('\r','DONE')]);
 assert.match(r.output,/Included: b7/);assert.match(r.output,/Omitted: old1, old2/);
 const dispatched=JSON.parse(r.output.match(/DISPATCH (.*)\r?\n/)[1]);
 assert.equal(dispatched.exact,true);assert.equal(dispatched.raw,false);assert.equal(dispatched.calls,1);
 assert.equal(dispatched.plan.request.target,'claude');assert.deepEqual(dispatched.plan.request.workspace,{kind:'source',path:root});
});
test('search shows a message excerpt in the list and attribution in the preview',()=>{
 const r=run([key('needle','Beta task · the hidden needle'),key('\r','Enter choose target'),key('\x1b','Enter preview'),key('\x1b','DONE')]);
 assert.match(r.output,/b7 \[assistant\]: the hidden needle/);assert.doesNotMatch(r.output,/DISPATCH/);
});
test('up from the first result focuses search and down selects the first filtered result',()=>{
 const r=run([key('\x1b[A','› Search:'),key('needle','Beta task · the hidden needle'),
  key('\x1b[B','› claude Beta task'),key('\r','Enter choose target'),key('\r','Target:'),key('\x03','DONE')]);
 assert.match(r.frames[1],/› Search:[^\r\n]*\r?\n[^\r\n]*Alpha task/);
 assert.doesNotMatch(r.frames[2],/› claude/);
 assert.match(r.frames[5],/Choose target/);
 assert.doesNotMatch(r.frames[5],/Search:|Tab Scope:/);
});
test('source warnings stay off the session list and open with F2',()=>{
 const r=run([key('\x1bOQ','untested-producer'),key('\x1b','Alpha task'),key('\x03','DONE')],'source-status');
 assert.match(r.frames[0],/F2 source status/);
 assert.doesNotMatch(r.frames[0],/untested-producer/);
 assert.match(r.frames[1],/Source status/);
});
test('last-used times and selection details remain visible after resizing',()=>{
 const r=run([key('\x1b[B','Second opening request'),{resize:[24,76],wait:'Second opening request'},key('\x03','DONE')],'details');
 assert.match(r.frames[0],/Alpha task[^\n]*18m ago/);
 assert.match(r.frames[1],/Beta task[^\n]*2h ago/);
 assert.match(r.frames[2],/Details/);
 assert.match(r.frames[2],/Last used: .* UTC/);
 assert.match(r.frames[2],/Folder: /);
 assert.doesNotMatch(r.output,/First opening request/);
});

const openTarget=[key('\r','Enter choose target'),key('\r','Target:')];
const noDispatch=r=>assert.doesNotMatch(r.output,/DISPATCH/);
test('keyboard selection, source filter, scope, empty results and backspace stay independent',()=>{
 const r=run([key('\x1b[B','› claude Beta'),key('\x1b[A','› codex'),key('\x1b[C','Agent: codex'),
  key('\x1b[C','Agent: claude'),key('\t','Elsewhere task'),key('\x1b[D','Agent: codex'),
  key('zzz','No matching sessions'),key('\x7f\x7f\x7f','Alpha task'),key('\x03','DONE')]);
 assert.doesNotMatch(r.frames[0],/Elsewhere task|Public transcript/);noDispatch(r);
});
test('global selection defaults to recorded source workspace',()=>{
 const r=run([key('\x1b[B\x1b[B','› claude Elsewhere'),...openTarget,key('\r','Mode:'),key('\r','DONE')],'global');
 const p=JSON.parse(r.output.match(/DISPATCH (.*)\r?\n/)[1]);
 assert.deepEqual(p.plan.request.workspace,{kind:'source',path:other});
});
test('explicit workspace override is included in final summary and exact request',()=>{
 const r=run([...openTarget,key('w','Explicit workspace override'),key(other,other),key('\r','Mode:'),key('\r','DONE')]);
 const p=JSON.parse(r.output.match(/DISPATCH (.*)\r?\n/)[1]);
 assert.deepEqual(p.plan.request.workspace,{kind:'override',path:other});
});
test('missing source directory requires recovery or cancellation',()=>{
 const r=run([key('\x1b[B\x1b[B','Elsewhere task'),...openTarget,key('\r','Workspace unavailable'),
 key('w','Explicit workspace override'),key(root,root),key('\r','Mode:'),key('\x03','DONE')],
 'missing',{PICKER_OTHER:join(root,'deleted')});noDispatch(r);
});
for(const signal of ['SIGTERM','SIGINT']) test(`${signal} cleans up without dispatch`,()=>noDispatch(run([{signal,wait:'DONE'}])));
test('resize redraws without exit and Ctrl+C restores terminal',()=>{
 const r=run([{resize:[12,60],wait:'Enter preview'},key('\x03','DONE')]);noDispatch(r);
});
test('query error supports explicit retry without continuation',()=>{
 const r=run([key('\x12','Alpha task'),key('\x03','DONE')],'query-error');noDispatch(r);
});
for(const [scenario,steps,error] of [
 ['preview-error',[key('\r','offline preview failed')],'preview'],
 ['prepare-error',[...openTarget,key('\r','offline preparation failed')],'preparation'],
]) test(`${error} read retry does not dispatch`,()=>{
 const r=run([...steps,key('r',scenario === 'preview-error'?'Enter choose target':'Mode:'),key('\x03','DONE')],scenario);noDispatch(r);
});
test('callback failure occurs after terminal cleanup',()=>{
 const r=run([...openTarget,key('\r','Mode:'),key('\r','ERROR offline callback failed')],'callback-error');
 assert.match(r.output,/"raw":false/);assert.equal((r.output.match(/DISPATCH/g)||[]).length,1);
});
test('native resume mode is supplied by service even for a different target',()=>{
 const r=run([...openTarget,key('\x1b[C','Target: claude'),key('\r','Mode: native-resume'),key('\x03','DONE')],'native');noDispatch(r);
});
test('stale query results do not replace a newer search',()=>{
 const r=run([key('slow','Search: slow'),key('\x7f\x7f\x7f\x7fneedle','Beta task'),{wait:'LATE QUERY'},key('\x03','DONE')]);
 const late=r.output.slice(r.output.indexOf('LATE QUERY'));
 assert.doesNotMatch(late,/No matching sessions/);noDispatch(r);
});
for(const [scenario,steps,late] of [
 ['late-preview',[key('\r','Loading…')],'LATE PREVIEW'],
 ['late-prepare',[...openTarget,key('\r','Loading…')],'LATE PREPARE'],
]) test(`${scenario} cannot redraw or dispatch after cancellation`,()=>{
 const r=run([...steps,key('\x03','DONE'),{wait:late}],scenario);
 const after=r.output.slice(r.output.indexOf('DONE'));
 assert.doesNotMatch(after,/\x1b\[2J|DISPATCH/);noDispatch(r);
});

// Fault injection complements real PTYs for terminal APIs that normally do not throw.
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { runPicker } from '../dist/tui/app.js';
function terminal() {
 const input=new PassThrough();input.isTTY=true;input.isRaw=false;
 input.setRawMode=function(value){this.isRaw=value;return this;};
 const output=new PassThrough();output.isTTY=true;output.rows=24;output.columns=80;
 return {input,output,signals:new EventEmitter()};
}
for(const fault of ['setup','draw','keypress','resize','input-error','output-error']) test(`${fault} failure restores terminal and listeners`,async()=>{
 const t=terminal();const baseline=t.input.eventNames().map(e=>[e,t.input.listenerCount(e)]);
 const options={terminal:t,workspace:root,query:async()=>[],preview:async()=>[],prepare:async()=>{throw Error('unused');},continue:async()=>{throw Error('unexpected dispatch');}};
 const error=Error(`injected ${fault}`);
 if(fault==='setup'){const set=t.input.setRawMode;t.input.setRawMode=function(value){if(value)throw error;return set.call(this,value);};}
 if(fault==='draw'){const write=t.output.write;t.output.write=function(value,...args){if(value.startsWith('\x1b[2J'))throw error;return write.call(this,value,...args);};}
 const running=runPicker(options);
 if(!['setup','draw'].includes(fault)) {
  await new Promise(resolve=>setImmediate(resolve));
  if(fault==='keypress'||fault==='resize') {
   const write=t.output.write;t.output.write=function(value,...args){if(value.startsWith('\x1b[2J'))throw error;return write.call(this,value,...args);};
   if(fault==='keypress')t.input.emit('keypress',undefined,{name:'down'});else t.output.emit('resize');
  }else (fault==='input-error'?t.input:t.output).emit('error',error);
 }
 await assert.rejects(running,error);
 assert.equal(t.input.isRaw,false);assert.equal(t.input.readableFlowing,false);
 assert.deepEqual(t.input.eventNames().map(e=>[e,t.input.listenerCount(e)]),baseline);
 assert.equal(t.output.listenerCount('resize'),0);assert.equal(t.output.listenerCount('error'),0);
 assert.equal(t.signals.listenerCount('SIGINT'),0);assert.equal(t.signals.listenerCount('SIGTERM'),0);
});

test('obsolete preview cannot replace the list after backing out',()=>{
 const r=run([key('\r','Loading…'),key('\x1b','Enter preview'),{wait:'LATE PREVIEW'},key('\x03','DONE')],'obsolete-preview');
 assert.doesNotMatch(r.output.slice(r.output.indexOf('LATE PREVIEW')),/Public transcript|\x1b\[2J/);noDispatch(r);
});

test('PTY reader preserves ordered markers across split and coalesced output',()=>{
 const result=spawnSync('python3',['test/fixtures/terminal_reader_test.py'],{encoding:'utf8',timeout:5000});
 assert.equal(result.status,0,result.stderr);
});
