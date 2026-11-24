import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileTempDir } from './fixtures/temp.mjs';
const root=fileTempDir('agentswitch-picker-');
const other=join(root,'other');mkdirSync(other);
const run=(actions,scenario='',extra={})=>{
 const p=spawnSync('python3',['test/fixtures/drive-terminal.py'],{input:JSON.stringify({env:{PICKER_WORKSPACE:root,PICKER_OTHER:other,PICKER_SCENARIO:scenario,...extra},actions,...(scenario==='query-error'?{initial:'offline query failed'}:{})}),encoding:'utf8',timeout:15000});
 assert.equal(p.status,0,p.stderr);const result=JSON.parse(p.stdout);assert.equal(result.restored,true,result.output);
 const done=result.output.match(/DONE (.*)\r?\n/);if(done){const state=JSON.parse(done[1]);assert.deepEqual(state.listeners,state.before);}assert.match(result.output,/\x1b\[\?25h\x1b\[\?1049l/);return result;
};
const key=(send,wait)=>({send,wait});
// The picker clips an input wider than the terminal, so wait for the start of a typed path; a deep temp root makes it that wide.
const typePath=path=>key(path,path.slice(0,40));
test('production picker confirms exact prepared plan after terminal cleanup',()=>{
 const r=run([key('\r','Public transcript'),key('\r','Target:'),key('\x1b[C','Target: claude'),key('\r','Mode: fresh-handoff'),key('\r','DONE')]);
 assert.match(r.output,/Included: b7/);assert.match(r.output,/Omitted: old1, old2/);
 const dispatched=JSON.parse(r.output.match(/DISPATCH (.*)\r?\n/)[1]);
 assert.equal(dispatched.exact,true);assert.equal(dispatched.raw,false);assert.equal(dispatched.calls,1);
 assert.equal(dispatched.plan.request.target,'claude');assert.deepEqual(dispatched.plan.request.workspace,{kind:'source',path:root});
});
test('search shows a message excerpt in the list and the matched item in the preview',()=>{
 const r=run([key('needle','Beta task · the hidden needle'),key('\r','Enter choose target'),key('\x1b','Enter preview'),key('\x1b','DONE')]);
 const preview=r.frames[2].replace(/\x1b\[[0-9;]*m/g,'');
 assert.match(preview,/● claude\r?\n  Public transcript needle/);assert.doesNotMatch(preview,/Match |b7/);assert.doesNotMatch(r.output,/DISPATCH/);
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
 const r=run([...openTarget,key('w','Explicit workspace override'),typePath(other),key('\r','Mode:'),key('\r','DONE')]);
 const p=JSON.parse(r.output.match(/DISPATCH (.*)\r?\n/)[1]);
 assert.deepEqual(p.plan.request.workspace,{kind:'override',path:other});
});
test('missing source directory requires recovery or cancellation',()=>{
 const r=run([key('\x1b[B\x1b[B','Elsewhere task'),...openTarget,key('\r','Workspace unavailable'),
 key('w','Explicit workspace override'),typePath(root),key('\r','Mode:'),key('\x03','DONE')],
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

// Transcript preview (#16). In-process terminal with controlled size and colour.
const transcript=[
 {id:'item-u1-7f3a',role:'user',status:'complete',text:'First line of the request\nSecond line\r\nThird\tafter tab'},
 {id:'item-a1-91bc',role:'assistant',status:'complete',text:'Answer with \x1b[31mred\x1b[0m and ‮bidi‬ markers'},
 {id:'item-t1-0d2e',role:'tool',status:'complete',text:Array.from({length:10},(_,i)=>`tool line ${i+1}`).join('\n')},
 {id:'item-a2-55f0',role:'assistant',status:'interrupted',text:'Partial reply that stopped'},
 {id:'item-t2-c3d4',role:'tool',status:'failed',text:'command failed: needle-xyz'},
];
const sessionHit={id:'codex:sess',nativeId:'sess-native-1',agent:'codex',title:'Fix the flaky upload test',workspace:root,updatedAt:new Date(Date.now()-18*60_000).toISOString()};
const sgr=/\x1b\[[0-9;]*m/g;
async function picker({items=transcript,rows=60,columns=100,color=false,match=false}={}) {
 const t=terminal();t.output.rows=rows;t.output.columns=columns;
 let written='';t.output.on('data',chunk=>{written+=chunk;});
 const saved={NO_COLOR:process.env.NO_COLOR,TERM:process.env.TERM};
 if(color){delete process.env.NO_COLOR;process.env.TERM='xterm-256color';}else process.env.NO_COLOR='1';
 const running=runPicker({terminal:t,workspace:root,
  query:async q=>[{...sessionHit,matches:match&&q.text==='needle-xyz'?[{field:'message',itemId:'item-t2-c3d4',role:'tool',text:'command failed: needle-xyz'}]:[]}],
  preview:async()=>items,prepare:async()=>{throw Error('unused');},continue:async()=>{throw Error('unexpected dispatch');}});
 const frames=()=>written.split('\x1b[2J\x1b[H').slice(1);
 const frame=()=>frames().at(-1)??'';
 const until=async(test,label)=>{for(let i=0;i<200;i++){if(test(frame()))return frame();await new Promise(r=>setTimeout(r,10));}throw Error(`Missing ${label} in ${JSON.stringify(frame())}`);};
 const send=async(data,expect,label=expect)=>{const before=frames().length;t.input.write(data);return until(text=>frames().length>before&&(typeof expect==='function'?expect(text):text.includes(expect)),label);};
 await until(text=>text.includes('Fix the flaky upload test'),'list');
 return {t,frame,until,send,written:()=>written,stop:async()=>{t.input.write('\x03');await running;Object.assign(process.env,saved);for(const k of ['NO_COLOR','TERM'])if(saved[k]===undefined)delete process.env[k];}};
}
const open=p=>p.send('\r','Enter choose target');
const plainRows=text=>text.replace(sgr,'').split('\n');

test('T1/T4/T5: the preview renders a session header and role blocks without item IDs or complete tags',async()=>{
 const p=await picker();const text=await open(p);const rows=plainRows(text);await p.stop();
 for(const row of ['Fix the flaky upload test','Agent: codex',`Folder: ${root}`,'Session ID: sess-native-1','5 items · 1 user · 2 assistant · 2 tool'])assert.ok(rows.some(line=>line.includes(row)),row);
 assert.equal(rows.filter(line=>line.includes('sess-native-1')).length,1);
 assert.ok(rows.some(line=>/^Last used: 18m ago/.test(line)));
 const you=rows.findIndex(line=>line.startsWith('● You'));const codex=rows.findIndex(line=>line.startsWith('● codex'));
 assert.ok(you>0&&codex>you);assert.equal(rows[codex-1],'');assert.equal(rows[you-1],'');
 for(const item of transcript)assert.ok(!p.written().includes(item.id),item.id);
 assert.ok(!rows.join('\n').includes('complete'));
 assert.match(rows.find(line=>line.includes('Partial reply')===false&&line.startsWith('● codex')&&line.includes('interrupted'))??'',/interrupted/);
 assert.ok(rows.some(line=>line.startsWith('⏺ tool output · 1 line')&&line.includes('failed')));
 assert.ok(rows.some(line=>line.startsWith('⏺ tool output · 10 lines')));
});
test('T2: line breaks and tabs become rows and spaces while terminal controls stay escaped',async()=>{
 const p=await picker();const text=await open(p);const rows=plainRows(text);await p.stop();
 const first=rows.indexOf('  First line of the request');
 assert.ok(first>0);assert.equal(rows[first+1],'  Second line');assert.equal(rows[first+2],'  Third  after tab');
 assert.doesNotMatch(p.written(),/\\u000a|\\u000d|\\u0009/);
 assert.ok(rows.some(line=>line.includes('Answer with \\u001b[31mred\\u001b[0m and \\u202ebidi\\u202c markers')));
 assert.ok(!p.written().includes('\x1b[31m')&&!p.written().includes('‮'));
});
test('T3: tool output shows three lines until T expands it, and T collapses it again',async()=>{
 const p=await picker();let rows=plainRows(await open(p));
 assert.ok(rows.includes('  tool line 3')&&!rows.includes('  tool line 4'));assert.ok(rows.includes('  … 7 more lines'));assert.match(rows.join('\n'),/T show tool output/);
 rows=plainRows(await p.send('t','tool line 10'));assert.ok(rows.includes('  tool line 10')&&!rows.some(line=>line.includes('more lines')));assert.match(rows.join('\n'),/T hide tool output/);
 rows=plainRows(await p.send('t','7 more lines'));assert.ok(!rows.includes('  tool line 4'));
 await p.stop();
});
test('T6: a message match opens the preview on the matched item and highlights the matched text',async()=>{
 const p=await picker({rows:14,color:true,match:true});
 await p.send('needle-xyz','needle-xyz');
 const text=await p.send('\r','Enter choose target');await p.stop();
 assert.match(text,/⏺ tool output · 1 line/);assert.match(text,/\x1b\[[0-9;]*mneedle-xyz\x1b\[0m/);
 assert.doesNotMatch(text.replace(sgr,''),/Match |Session ID/);
});
test('T7: an empty history explains that only metadata is readable',async()=>{
 const p=await picker({items:[]});const rows=plainRows(await open(p));await p.stop();
 assert.ok(rows.includes('No readable conversation in this session (metadata only).'));
});
test('T8: PgDn and PgUp scroll by one body height',async()=>{
 const tall=await picker();const all=plainRows(await tall.send('t\r'.slice(1),'Enter choose target'));await tall.stop();
 const body=all.slice(2,all.indexOf('',all.length-3));
 const p=await picker({rows:12});const first=plainRows(await open(p));
 const bodyRows=12-4;assert.deepEqual(first.slice(2,2+bodyRows),body.slice(0,bodyRows));
 const next=plainRows(await p.send('\x1b[6~',text=>plainRows(text)[2]!==first[2],'PgDn'));assert.deepEqual(next.slice(2,2+bodyRows),body.slice(bodyRows,2*bodyRows));
 const back=plainRows(await p.send('\x1b[5~',text=>plainRows(text)[2]===first[2],'PgUp'));assert.deepEqual(back.slice(2,2+bodyRows),first.slice(2,2+bodyRows));
 await p.stop();
});
test('T9: with NO_COLOR the preview has the same rows and no colour sequences',async()=>{
 const plain=await picker();const off=await open(plain);await plain.stop();
 const colored=await picker({color:true});const on=await open(colored);await colored.stop();
 assert.doesNotMatch(off,/\x1b\[/);assert.match(on,sgr);assert.equal(on.replace(sgr,''),off);
});

for(const [columns,color] of [[80,true],[130,true],[80,false]]) test(`PTY: a real-looking transcript fits ${columns} columns${color?'':' with NO_COLOR'}`,()=>{
 const r=run([{resize:[32,columns],wait:'Alpha task'},key('\r','Enter choose target'),key('\x03','DONE')],'transcript',color?{TERM:'xterm-256color'}:{NO_COLOR:'1'});
 const frame=r.frames[2];const rows=frame.replace(sgr,'').split(/\r?\n/);
 if(color)assert.match(frame,sgr);else assert.doesNotMatch(frame,sgr);
 for(const row of rows)assert.ok(Array.from(row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'')).length<columns,JSON.stringify(row));
 for(const expected of ['Alpha task','Agent: codex','5 items · 1 user · 2 assistant · 2 tool','● You','  Please fix the flaky upload test.','  It fails about once in ten runs on CI.','● codex','⏺ tool output · 12 lines','  $ npm test -- --grep upload','  > agentswitch@0.1.0 test','  … 8 more lines','T show tool output'])
  assert.ok(rows.some(row=>row.includes(expected)),expected);
 assert.ok(rows.some(row=>/^  ok 1 - upload retries attempt 1 \.+…$/.test(row)),'long tool line is clipped to one row');
 if(columns===80)assert.ok(rows.includes('  the retry logic in the upload worker.'),'prose wraps between words');
});
