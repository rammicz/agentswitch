import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileTempDir } from './fixtures/temp.mjs';
import { assertMissing, scaled } from './fixtures/timeouts.mjs';
const root=fileTempDir('agentswitch-picker-');
const other=join(root,'other');mkdirSync(other);
const run=(actions,scenario='',extra={})=>{
 const p=spawnSync('python3',['test/fixtures/drive-terminal.py'],{input:JSON.stringify({env:{PICKER_WORKSPACE:root,PICKER_OTHER:other,PICKER_SCENARIO:scenario,...extra},actions,...(scenario==='query-error'?{initial:'offline query failed'}:{})}),encoding:'utf8',timeout:scaled(120_000)});
 assert.equal(p.status,0,p.stderr);const result=JSON.parse(p.stdout);assert.equal(result.restored,true,result.output);
 const done=result.output.match(/DONE (.*)\r?\n/);if(done){const state=JSON.parse(done[1]);assert.deepEqual(state.listeners,state.before);}assert.match(result.output,/\x1b\[\?25h\x1b\[\?1049l/);return result;
};
const key=(send,wait)=>({send,wait});
// An input wider than the terminal shows its end, so wait for the end of a typed path; a deep temp root makes it that wide.
const typePath=path=>key(path,path.slice(-40));
test('production picker confirms exact prepared plan after terminal cleanup',()=>{
 const r=run([key('\r','Public transcript'),key('\r','change target'),key('\x1b[C','[claude]'),key('\r','Mode  fresh handoff'),key('\r','DONE')]);
 assert.match(r.output,/Included IDs  b7/);assert.match(r.output,/Omitted IDs  old1, old2/);
 const dispatched=JSON.parse(r.output.match(/DISPATCH (.*)\r?\n/)[1]);
 assert.equal(dispatched.exact,true);assert.equal(dispatched.raw,false);assert.equal(dispatched.calls,1);
 assert.equal(dispatched.plan.request.target,'claude');assert.deepEqual(dispatched.plan.request.workspace,{kind:'source',path:root});
});
test('search shows a message excerpt in the list and the matched item in the preview',()=>{
 const r=run([key('needle','Beta task · the hidden needle'),key('\r','Enter choose target'),key('\x1b','Enter preview'),key('\x1b','DONE')]);
 const preview=r.frames[2].replace(/\x1b\[[0-9;]*m/g,'');
 assert.match(preview,/● claude\r?\n {3}Public transcript needle/);assert.doesNotMatch(preview,/Match |b7/);assert.doesNotMatch(r.output,/DISPATCH/);
});
test('up from the first result focuses search and down selects the first filtered result',()=>{
 const r=run([key('\x1b[A','› Search:'),key('needle','Beta task · the hidden needle'),
  key('\x1b[B','› claude Beta task'),key('\r','Enter choose target'),key('\r','change target'),key('\x03','DONE')]);
 assert.match(r.frames[1].replace(sgr,''),/› Search:[^\r\n]*\r?\n *\r?\n[^\r\n]*Alpha task/);
 assert.doesNotMatch(r.frames[2],/› claude/);
 assert.match(r.frames[5],/Choose target/);
 assert.doesNotMatch(r.frames[5].replace(sgr,''),/Search:|Tab Scope:/);
});
test('source warnings stay off the session list and open with F2',()=>{
 const r=run([key('\x1bOQ','untested-producer'),key('\x1b','Alpha task'),key('\x03','DONE')],'source-status');
 assert.match(r.frames[0].replace(sgr,''),/F2 source status/);
 assert.doesNotMatch(r.frames[0],/untested-producer/);
 assert.match(r.frames[1],/Source status/);
});
test('last-used times and selection details remain visible after resizing',()=>{
 const r=run([key('\x1b[B','Second opening request'),{resize:[24,76],wait:'Second opening request'},key('\x03','DONE')],'details');
 assert.match(r.frames[0],/Alpha task[^\n]*18m ago/);
 assert.match(r.frames[1],/Beta task[^\n]*2h ago/);
 assert.match(r.frames[2],/Details/);
 assert.match(r.frames[2].replace(sgr,''),/Last used  .* UTC/);
 assert.match(r.frames[2].replace(sgr,''),/Folder  /);
 assert.doesNotMatch(r.output,/First opening request/);
});

const openTarget=[key('\r','Enter choose target'),key('\r','change target')];
const noDispatch=r=>assert.doesNotMatch(r.output,/DISPATCH/);
test('keyboard selection, source filter, scope, empty results and backspace stay independent',()=>{
 const r=run([key('\x1b[B','› claude Beta'),key('\x1b[A','› codex'),key('\x1b[C','Agent: codex'),
  key('\x1b[C','Agent: claude'),key('\t','Elsewhere task'),key('\x1b[D','Agent: codex'),
  key('zzz','No matching sessions'),key('\x7f\x7f\x7f','Alpha task'),key('\x03','DONE')]);
 assert.doesNotMatch(r.frames[0],/Elsewhere task|Public transcript/);noDispatch(r);
});
test('global selection defaults to recorded source workspace',()=>{
 const r=run([key('\x1b[B\x1b[B','› claude Elsewhere'),...openTarget,key('\r','Mode  '),key('\r','DONE')],'global');
 const p=JSON.parse(r.output.match(/DISPATCH (.*)\r?\n/)[1]);
 assert.deepEqual(p.plan.request.workspace,{kind:'source',path:other});
});
test('explicit workspace override is included in final summary and exact request',()=>{
 const r=run([...openTarget,key('w','Explicit workspace override'),typePath(other),key('\r','Mode  '),key('\r','DONE')]);
 const p=JSON.parse(r.output.match(/DISPATCH (.*)\r?\n/)[1]);
 assert.deepEqual(p.plan.request.workspace,{kind:'override',path:other});
});
test('missing source directory requires recovery or cancellation',()=>{
 const r=run([key('\x1b[B\x1b[B','Elsewhere task'),...openTarget,key('\r','Workspace unavailable'),
 key('w','Explicit workspace override'),typePath(root),key('\r','Mode  '),key('\x03','DONE')],
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
 const r=run([...steps,key('r',scenario === 'preview-error'?'Enter choose target':'Mode  '),key('\x03','DONE')],scenario);noDispatch(r);
});
test('callback failure occurs after terminal cleanup',()=>{
 const r=run([...openTarget,key('\r','Mode  '),key('\r','ERROR offline callback failed')],'callback-error');
 assert.match(r.output,/"raw":false/);assert.equal((r.output.match(/DISPATCH/g)||[]).length,1);
});
test('native resume mode is supplied by service even for a different target',()=>{
 const r=run([...openTarget,key('\x1b[C','[claude]'),key('\r','Mode  native resume'),key('\x03','DONE')],'native');noDispatch(r);
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
import { compactPath, runPicker } from '../dist/tui/app.js';
import { DEFAULT_CURRENT_REQUEST } from '../dist/handoff-format.js';
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
 const result=spawnSync('python3',['test/fixtures/terminal_reader_test.py'],{encoding:'utf8',timeout:scaled(30_000)});
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
const sgr=/\x1b\[[0-9;]*m/g,hasSgr=/\x1b\[[0-9;]*m/;
// Pickers a test leaves running, for example after a failed assertion. Stopping one restores the environment it changed,
// so one failing test cannot change what later tests see.
const livePickers=new Set();
async function settlePickers(){for(const stop of [...livePickers])await stop();}
afterEach(settlePickers);
async function picker({items=transcript,rows=60,columns=100,color=false,match=false,dumb=false,hits=[sessionHit],...services}={}) {
 const t=terminal();t.output.rows=rows;t.output.columns=columns;
 let written='';t.output.on('data',chunk=>{written+=chunk;});
 const saved={NO_COLOR:process.env.NO_COLOR,TERM:process.env.TERM};
 if(color){delete process.env.NO_COLOR;process.env.TERM='xterm-256color';}else if(dumb){delete process.env.NO_COLOR;process.env.TERM='dumb';}else process.env.NO_COLOR='1';
 const running=runPicker({terminal:t,workspace:root,
  query:async q=>hits.map(hit=>({...hit,matches:match&&q.text==='needle-xyz'?[{field:'message',itemId:'item-t2-c3d4',role:'tool',text:'command failed: needle-xyz'}]:[]})),
  preview:async()=>items,prepare:async()=>{throw Error('unused');},continue:async()=>{throw Error('unexpected dispatch');},...services});
 const frames=()=>written.split('\x1b[2J\x1b[H').slice(1);
 const frame=()=>frames().at(-1)??'';
 const until=async(test,label)=>{for(let i=0;i<200;i++){if(test(frame()))return frame();await new Promise(r=>setTimeout(r,10));}throw Error(`Missing ${label} in ${JSON.stringify(frame())}`);};
 const send=async(data,expect,label=expect)=>{const before=frames().length;t.input.write(data);return until(text=>frames().length>before&&(typeof expect==='function'?expect(text):text.replace(sgr,'').includes(expect)),label);};
 let stopped;
 const stop=()=>stopped??=(async()=>{
  livePickers.delete(stop);t.input.write('\x03');
  try{await running;}finally{for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;}
 })();
 livePickers.add(stop);
 try{await until(text=>text.replace(sgr,'').includes('Details'),'list');}catch(error){await stop();throw error;}
 return {t,frame,until,send,written:()=>written,stop};
}
const open=p=>p.send('\r','Enter choose target');
// Rows without colour and without the one-cell left margin.
const plainRows=text=>text.replace(sgr,'').split('\n').map(row=>row.slice(1));
// A frame is the 2-row heading, the body, a blank row and the footer.
const bodyOf=(rows,height)=>rows.slice(2,height-2);

test('T1/T4/T5: the preview renders a session header and role blocks without item IDs or complete tags',async()=>{
 const p=await picker();const text=await open(p);const rows=plainRows(text);await p.stop();
 for(const row of ['Fix the flaky upload test','Agent: codex',`Folder: ${compactPath(root,90)}`,'Session ID: sess-native-1','5 items · 1 user · 2 assistant · 2 tool'])assert.ok(rows.some(line=>line.includes(row)),row);
 assert.equal(rows.filter(line=>line.includes('sess-native-1')).length,1);
 assert.ok(rows.some(line=>/^Last used: 18m ago/.test(line)));
 const you=rows.findIndex(line=>line.startsWith('● You'));const codex=rows.findIndex(line=>line.startsWith('● codex'));
 assert.ok(you>0&&codex>you);assert.equal(rows[codex-1],'');assert.equal(rows[you-1],'');
 for(const item of transcript)assert.ok(!p.written().includes(item.id),item.id);
 assert.ok(!rows.join('\n').includes('complete'));
 assert.ok(rows.some(line=>line.startsWith('● codex')&&line.includes('interrupted')));
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
test('preview rows fit the terminal from 14 to 80 columns, including the empty state and status tags',async()=>{
 const tagged=[{id:'u1',role:'user',status:'interrupted',text:'Stop here'},{id:'a1',role:'assistant',status:'failed',text:'Partial reply'},
  {id:'t1',role:'tool',status:'complete',text:Array.from({length:40},(_,i)=>`line ${i}`).join('\n')}];
 for(const columns of [14,20,30,40,56,80])for(const items of [[],tagged]) {
  const p=await picker({items,columns,rows:60});const rows=plainRows(await p.send('\r',text=>text.includes('Agent: codex')&&!text.includes('Loading'),'loaded preview'));await p.stop();
  for(const row of rows)assert.ok(Array.from(row).length<columns,`${columns} columns: ${JSON.stringify(row)}`);
  if(!items.length)assert.ok(rows.join(' ').replace(/ +/g,' ').includes('No readable conversation in this session (metadata only).'));
 }
});
test('T8: PgDn and PgUp scroll by one body height',async()=>{
 const tall=await picker();const all=plainRows(await open(tall));await tall.stop();
 const body=all.slice(2,-2);
 const p=await picker({rows:12});const first=bodyOf(plainRows(await open(p)),12);const bodyRows=first.length;
 assert.deepEqual(first,body.slice(0,bodyRows));
 const next=bodyOf(plainRows(await p.send('\x1b[6~',text=>plainRows(text)[2]!==first[0],'PgDn')),12);assert.deepEqual(next,body.slice(bodyRows,2*bodyRows));
 const back=bodyOf(plainRows(await p.send('\x1b[5~',text=>plainRows(text)[2]===first[0],'PgUp')),12);assert.deepEqual(back,first);
 await p.stop();
});
test('T9: with NO_COLOR the preview has the same rows and no colour sequences',async()=>{
 const plain=await picker();const off=await open(plain);await plain.stop();
 const colored=await picker({color:true});const on=await open(colored);await colored.stop();
 assert.doesNotMatch(off,/\x1b\[/);assert.match(on,hasSgr);assert.equal(on.replace(sgr,''),off);
});

for(const [columns,color] of [[80,true],[130,true],[80,false]]) test(`PTY: a real-looking transcript fits ${columns} columns${color?'':' with NO_COLOR'}`,()=>{
 const r=run([{resize:[32,columns],wait:'Alpha task'},key('\r','Enter choose target'),key('\x03','DONE')],'transcript',color?{TERM:'xterm-256color'}:{NO_COLOR:'1'});
 const frame=r.frames[2];const rows=frame.replace(sgr,'').split(/\r?\n/).map(row=>row.slice(1));
 if(color)assert.match(frame,hasSgr);else assert.doesNotMatch(frame,hasSgr);
 for(const row of rows)assert.ok(Array.from(row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'')).length<columns,JSON.stringify(row));
 for(const expected of ['Alpha task','Agent: codex','5 items · 1 user · 2 assistant · 2 tool','● You','  Please fix the flaky upload test.','  It fails about once in ten runs on CI.','● codex','⏺ tool output · 12 lines','  $ npm test -- --grep upload','  > agentswitch@0.1.0 test','  … 8 more lines','T show tool output'])
  assert.ok(rows.some(row=>row.includes(expected)),expected);
 assert.ok(rows.some(row=>/^  ok 1 - upload retries attempt 1 \.+…$/.test(row)),'long tool line is clipped to one row');
 if(columns===80)assert.ok(rows.includes('  the retry logic in the upload worker.'),'prose wraps between words');
});

// Shared palette, spacing and readable list, target and summary screens (#17).
const codexHit={id:'codex:019a0000-0000-7000-8000-000000000001',nativeId:'019a0000-0000-7000-8000-000000000001',agent:'codex',title:'Fix the flaky upload test',workspace:root,updatedAt:new Date(Date.now()-3*60_000).toISOString()};
const claudeHit={id:'claude:10000000-0000-4000-8000-000000000001',nativeId:'10000000-0000-4000-8000-000000000001',agent:'claude',title:'Review the retry logic',workspace:root,updatedAt:new Date(Date.now()-2*3_600_000).toISOString()};
const exactLines=['Exact initial user prompt (7 UTF-8 bytes):','BEGIN EXACT PROMPT JSON STRING','"hello"','END EXACT PROMPT JSON STRING'];
const screens={hits:[codexHit,claudeHit],compose:true,
 details:async()=>[{id:'d1',role:'user',status:'complete',text:'<command-message>x</command-message> <command-name>/x</command-name> <command-args>do it</command-args>'}],
 prepare:async request=>({plan:request,summary:{source:request.source,target:request.target,mode:request.target===request.source.agent&&!request.fresh?'native-resume':'fresh-handoff',
  workspace:request.workspace.path,includedItemIds:['item-a','item-b'],omittedItemIds:['item-c'],previewLines:exactLines}}),
 outcome:async request=>({native:request.target==='codex'&&!request.fresh,text:`Outcome for ${request.target}${request.fresh?' fresh':''} in ${request.workspace.kind}.`})};
const cells=row=>Array.from(row).length;
const sgrOf=(text,word)=>new RegExp(`(\\x1b\\[[0-9;]*m)${word}`).exec(text)?.[1];

test('#17 T1/T3: one palette colours the heading, each agent and the keycap footer',async()=>{
 const p=await picker({...screens,color:true,rows:24,columns:80});const list=p.frame();await p.stop();
 const heading=sgrOf(list,'agentswitch'),codex=sgrOf(list,'codex '),claude=sgrOf(list,'claude');
 assert.ok(heading&&codex&&claude);assert.notEqual(codex,claude);assert.notEqual(codex,heading);assert.notEqual(claude,heading);
 const footer=plainRows(list).find(row=>row.includes('Enter preview'));assert.equal(footer,'↑↓ select  Enter preview  Esc quit');
 assert.match(list,/\x1b\[1;[0-9;]*mEnter\x1b\[0m/);
});
test('#17 T2/T4: the list keeps 80x24 rows, blank rows around results and a labelled details pane',async()=>{
 const p=await picker({...screens,rows:24,columns:80});const rows=plainRows(await p.until(text=>text.includes('Opening request'),'excerpt'));await p.stop();
 assert.ok(rows.every(row=>cells(row)<=78),JSON.stringify(rows));
 const search=rows.findIndex(row=>row.includes('Search:'));assert.equal(rows[search+1],'');assert.match(rows[search+2],/codex +Fix the flaky upload test +3m ago$/);
 const footer=rows.findIndex(row=>row.startsWith('↑↓ select'));assert.equal(rows[footer-1],'');
 for(const row of ['Last used  ','Folder  ','Session ID  019a0000-0000-7000-8000-000000000001','Opening request: /x do it'])assert.ok(rows.some(line=>line.startsWith(row)),row);
 assert.doesNotMatch(rows.join('\n'),/<command-/);
 const wide=await picker({...screens,rows:32,columns:130});const side=plainRows(await wide.until(text=>text.includes('Opening request'),'excerpt'));await wide.stop();
 assert.ok(side.some(row=>/3m ago │ Details$/.test(row)));assert.ok(side.some(row=>row.endsWith('│ Opening request: /x do it')));
 assert.ok(side.every(row=>cells(row)<=128));
});
test('#17 T5: the target screen names the five targets and the service outcome, updating with ← → and F',async()=>{
 const asked=[];
 const p=await picker({...screens,rows:30,columns:80,outcome:request=>(asked.push(request),screens.outcome(request))});await open(p);let rows=plainRows(await p.send('\r','Outcome for codex in source.'));
 assert.ok(rows.includes('  [codex]  claude  opencode  agy  grok'));assert.ok(rows.includes('  Outcome for codex in source.'));
 for(const heading of ['To','Workspace','Handoff'])assert.equal(rows[rows.indexOf(heading)-1],'',heading);
 assert.ok(rows.every(row=>cells(row)<=78));
 for(const row of ['  Current request  Review the historical context','  Redactions  none','  Fresh context  off (automatic)','Enter review  Esc back  C edit request  X redact  F toggle fresh'])assert.ok(rows.some(line=>line.startsWith(row)),row);
 const start=rows.findIndex(row=>row.startsWith('  Current request  ')),end=rows.findIndex(row=>row.startsWith('  Redactions  '));
 assert.equal(rows.slice(start,end).map(row=>row.trim()).join(' '),'Current request  '+DEFAULT_CURRENT_REQUEST,'the request wraps between words');
 rows=plainRows(await p.send('\x1b[C','[claude]'));assert.ok(rows.includes('  Checking what this target will do…'),'no stale outcome while the service decides');
 rows=plainRows(await p.until(text=>text.includes('Outcome for claude in source.'),'claude outcome'));
 await p.send('\x1b[D','Outcome for codex in source.');
 await p.send('f','Outcome for codex fresh in source.');
 assert.deepEqual(asked.map(request=>[request.target,request.fresh,request.workspace.kind]),[['codex',false,'source'],['claude',false,'source'],['codex',false,'source'],['codex',true,'source']]);
 rows=plainRows(await p.send('x','Literal redaction'));await p.send('secret-word','secret-word');rows=plainRows(await p.send('\r','Redactions  1'));
 assert.ok(rows.includes('  Redactions  1 (•••)'));assert.doesNotMatch(rows.join('\n'),/secret-word/);
 await p.stop();
});
test('#17 T5: an outcome that arrives while the request editor is open is shown on return',async()=>{
 const p=await picker({...screens,rows:30,columns:80,outcome:async request=>{await new Promise(r=>setTimeout(r,300));return screens.outcome(request);}});await open(p);
 await p.send('\r','Checking what this target will do…');await p.send('c','Current request (sent separately');
 await new Promise(r=>setTimeout(r,500));const rows=plainRows(await p.send('\r','change target'));await p.stop();
 assert.ok(rows.includes('  Outcome for codex in source.'),JSON.stringify(rows));
});
test('#17 T5: an outcome the service refuses is shown as a warning, and no outcome is stated without the service',async()=>{
 const p=await picker({...screens,color:true,rows:30,columns:80,outcome:async()=>{throw Error('Selected public history is incomplete. Select F.');}});await open(p);
 const text=await p.send('\r','Select F.');await p.stop();
 assert.match(text,/\x1b\[38;2;[0-9;]*mSelected public history is incomplete\. Select F\.\x1b\[0m/);
 const {outcome,...without}=screens;const q=await picker({...without,rows:30,columns:80});await open(q);
 const rows=plainRows(await q.send('\r','change target'));await q.stop();
 assert.equal(rows[rows.indexOf('  [codex]  claude  opencode  agy  grok')+1],'  ← → change target');
});
test('#17 T6: the summary states mode and counts before IDs and keeps the exact payload rows unchanged',async()=>{
 const p=await picker({...screens,color:true,rows:40,columns:100});await open(p);await p.send('\r','change target');await p.send('\x1b[C','[claude]');
 const text=await p.send('\r','Enter confirm continuation');await p.stop();const rows=plainRows(text);
 for(const row of ['Continuation','  Mode  fresh handoff','  To  claude','History','  Included 2 of 3 items','  Omitted 1','  Included IDs  item-a, item-b','  Omitted IDs  item-c','Exact payload'])assert.ok(rows.includes(row),row);
 assert.ok(rows.indexOf('  Included 2 of 3 items')<rows.indexOf('  Included IDs  item-a, item-b'));
 const raw=text.split('\n').map(row=>row.slice(1));const start=raw.indexOf(exactLines[0]);
 assert.deepEqual(raw.slice(start,start+exactLines.length),exactLines,'payload rows are byte-identical and unstyled');
});
test('#17 T7: NO_COLOR and TERM=dumb render the coloured rows without any SGR sequence',async()=>{
 const render=async options=>{const p=await picker({...screens,rows:30,columns:100,...options});const list=await p.until(text=>text.includes('Opening request'),'excerpt');
  await open(p);const target=await p.send('\r','Outcome for codex in source.');const summary=await p.send('\r','Enter confirm continuation');await p.stop();return [list,target,summary];};
 const colored=await render({color:true});
 for(const plain of [await render({}),await render({dumb:true})]) {
  for(const [index,frame] of plain.entries()) {assert.doesNotMatch(frame,/\x1b\[/);assert.equal(frame,colored[index].replace(sgr,''));}
 }
});
test('#17 input rows that do not fit show their end at 80 columns',async()=>{
 const p=await picker({...screens,rows:24,columns:80});await open(p);await p.send('\r','change target');
 const long='/'+'segment/'.repeat(20)+'typing-end';
 await p.send('w','Explicit workspace override');let rows=plainRows(await p.send(long,'typing-end'));
 const row=rows.find(line=>line.endsWith('typing-end'));assert.ok(row.startsWith('…')&&cells(row)===78,row);
 await p.send('\x1b','change target');await p.send('c','Current request (sent separately');rows=plainRows(await p.send('\x15'+'word '.repeat(30)+'request-end','request-end'));
 assert.ok(rows.some(line=>line.startsWith('…')&&line.endsWith('request-end')&&cells(line)<=78));
 await p.send('\r','change target');await p.send('x','Literal redaction');rows=plainRows(await p.send('r'.repeat(100)+'redaction-end','redaction-end'));
 assert.ok(rows.some(line=>line.startsWith('…')&&line.endsWith('redaction-end')&&cells(line)<=78));
 await p.stop();
});
for(const [rows,columns,color] of [[24,80,true],[32,130,true],[24,80,false]]) test(`#17 PTY: list, target and summary fit ${columns}x${rows}${color?'':' with NO_COLOR'}`,()=>{
 const r=run([{resize:[rows,columns],wait:'Alpha task'},key('\r','Enter choose target'),key('\r','session natively.'),key('\r','Enter confirm continuation'),key('\x03','DONE')],'',color?{TERM:'xterm-256color'}:{NO_COLOR:'1'});
 const [list,target,summary]=[1,3,4].map(index=>r.frames[index].split('\x1b[2J\x1b[H').at(-1));
 for(const frame of [list,target,summary]) {
  if(color)assert.match(frame,hasSgr);else assert.doesNotMatch(frame,hasSgr);
  for(const row of frame.replace(sgr,'').split(/\r?\n/))assert.ok(Array.from(row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'')).length<columns,JSON.stringify(row));
 }
 assert.match(list.replace(sgr,''),/↑↓ select  Enter preview  Esc quit/);
 assert.match(target.replace(sgr,''),/ To\r?\n   \[codex\]  claude  opencode  agy  grok\r?\n   Resumes the original codex session natively\./);
 assert.match(summary.replace(sgr,''),/ {3}Mode  fresh handoff/);assert.match(summary.replace(sgr,''),/ {3}Included 1 of 3 items/);
});

// A long folder (a macOS temp directory, say) stays on one row so the details and excerpts below it remain visible.
const longFolder='/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/agentswitch-test-run-2185-0JPdUG/agentswitch-picker-Sp0lZX';
test('compactPath abbreviates the home folder and elides the middle of a long path',()=>{
 assert.equal(compactPath('/Users/ana/projects/agentswitch',40,'/Users/ana'),'~/projects/agentswitch');
 assert.equal(compactPath('/Users/ana',40,'/Users/ana'),'~');
 assert.equal(compactPath('/Users/anabel/x',40,'/Users/ana'),'/Users/anabel/x');
 assert.equal(compactPath(longFolder,66,'/Users/ana'),'/var/…/agentswitch-test-run-2185-0JPdUG/agentswitch-picker-Sp0lZX');
 assert.equal(compactPath(longFolder,40,'/Users/ana'),'/var/…/agentswitch-picker-Sp0lZX');
 assert.equal(compactPath('/Users/ana/'+'x'.repeat(60),30,'/Users/ana'),'…'+'x'.repeat(29));
 for(const width of [10,20,30,40,60,80])assert.ok(cells(compactPath(longFolder,width,'/Users/ana'))<=width,String(width));
});
test('#17 a long folder takes one row in the details pane and the preview header at 80x24',async()=>{
 const p=await picker({...screens,hits:[{...codexHit,workspace:longFolder},claudeHit],rows:24,columns:80});
 const list=plainRows(await p.until(text=>text.includes('Opening request'),'excerpt'));
 assert.ok(list.includes('Folder  /var/…/T/agentswitch-test-run-2185-0JPdUG/agentswitch-picker-Sp0lZX'),JSON.stringify(list));
 const preview=plainRows(await open(p));await p.stop();
 assert.ok(preview.includes('Folder: /var/…/T/agentswitch-test-run-2185-0JPdUG/agentswitch-picker-Sp0lZX'),JSON.stringify(preview));
});

test('a picker left running by a failed test is stopped and the environment it changed is restored',async()=>{
 const before={NO_COLOR:process.env.NO_COLOR,TERM:process.env.TERM};
 await picker({color:true});assert.equal(process.env.TERM,'xterm-256color');assert.equal(process.env.NO_COLOR,undefined);
 await settlePickers();
 assert.deepEqual({NO_COLOR:process.env.NO_COLOR,TERM:process.env.TERM},before);assert.equal(livePickers.size,0);
 await assert.rejects(picker({color:true,query:()=>new Promise(()=>{})}),/Missing list/);
 assert.deepEqual({NO_COLOR:process.env.NO_COLOR,TERM:process.env.TERM},before);assert.equal(livePickers.size,0);
});
test('#17 a label and a long path start on one row: details Folder at 40, 80 and 130 columns, review Workspace at 80',async()=>{
 for(const columns of [40,80,130]) {
  const p=await picker({...screens,hits:[{...codexHit,workspace:longFolder},claudeHit],rows:30,columns});
  const rows=plainRows(await p.until(text=>text.includes('Session ID'),'details'));await p.stop();
  const folder=rows.find(row=>/(^|│ )Folder  /.test(row));
  assert.ok(folder&&/Folder  (\/var\/…\/|…).*agentswitch-picker-Sp0lZX$/.test(folder)&&cells(folder)<=columns-2,`${columns}: ${JSON.stringify(rows)}`);
  assert.ok(!rows.some(row=>/(^|│ )Folder$/.test(row)),`${columns}: bare label`);
 }
 const deep=join(root,'workspace-without-spaces-'+'x'.repeat(70));mkdirSync(deep,{recursive:true});
 const p=await picker({...screens,hits:[{...codexHit,workspace:deep}],rows:40,columns:80});await open(p);await p.send('\r','change target');
 const rows=plainRows(await p.send('\r','Enter confirm continuation'));await p.stop();
 const at=rows.findIndex(row=>row.startsWith('  Workspace  '));
 assert.ok(at>=0&&deep.startsWith(rows[at].slice('  Workspace  '.length)),JSON.stringify(rows));
 assert.ok(!rows.includes('  Workspace'));
});

test('a picker marker that never appears fails within its bound and shows the last screen',()=>{
 // The spawn limit is the bound on the whole run: a driver that hangs instead is killed without the expected message.
 const p=spawnSync('python3',['test/fixtures/drive-terminal.py'],{input:JSON.stringify({env:{PICKER_WORKSPACE:root,PICKER_OTHER:other,PICKER_SCENARIO:''},actions:[key('x','Search: x'),{wait:'NEVER_SHOWN',timeout:1}]}),encoding:'utf8',timeout:scaled(60_000)});
 assertMissing(p,'NEVER_SHOWN',1,/Search: x/);
});

// #37: prose wraps between words on every screen, and scrolling is offered only when the screen scrolls.
const joined=(rows,first)=>{const start=rows.findIndex(row=>row.includes(first));assert.ok(start>=0,JSON.stringify(rows));return rows.slice(start).map(row=>row.trim()).join(' ');};
test('#37 the target outcome, partial-history warning and item IDs wrap between words at 40 columns',async()=>{
 const text='Starts claude with a handoff of this conversation because its native session cannot be resumed here.';
 const partial='Partial history: at least 3 source records could not be read (unsupported-shape) and are not included.';
 const included=Array.from({length:9},(_,i)=>`item-${i}-abcdef`);
 const p=await picker({...screens,rows:40,columns:40,outcome:async()=>({native:false,text}),
  prepare:async request=>({plan:request,summary:{source:request.source,target:request.target,mode:'fresh-handoff',workspace:request.workspace.path,includedItemIds:included,omittedItemIds:[],partialHistory:partial}})});
 await open(p);
 const target=plainRows(await p.send('\r','resumed'));
 assert.ok(joined(target,'Starts claude').startsWith(text),JSON.stringify(target));
 const summary=plainRows(await p.send('\r','Enter confirm continuation'));await p.stop();
 assert.ok(joined(summary,'Partial history').startsWith(partial),JSON.stringify(summary));
 assert.ok(joined(summary,'Included IDs').startsWith(`Included IDs  ${included.join(', ')}`),JSON.stringify(summary));
 assert.ok([...target,...summary].every(row=>cells(row)<=38),JSON.stringify([...target,...summary]));
});
test('#37 preview and summary offer ↑↓ scroll only when their content is taller than the screen',async()=>{
 for(const [rows,items,scrolls] of [[40,transcript.slice(0,1),false],[16,transcript,true]]){
  const p=await picker({...screens,items,rows,columns:80});
  const preview=plainRows(await p.send('\r','Enter choose target'));
  assert.equal(preview.some(row=>row.includes('PgUp PgDn scroll')),scrolls,`${rows} rows: ${JSON.stringify(preview)}`);
  await p.send('\r','change target');
  const summary=plainRows(await p.send('\r','Enter confirm continuation'));await p.stop();
  assert.equal(summary.some(row=>row.includes('↑↓ scroll')),scrolls,`${rows} rows: ${JSON.stringify(summary)}`);
 }
});
test('#37 a short list gives the details its rows, and an excerpt the pane cannot hold ends with …',async()=>{
 const text='Opening request: '+Array.from({length:40},(_,i)=>`word${i}`).join(' ');
 const p=await picker({...screens,rows:24,columns:40,details:async()=>[{id:'d1',role:'user',status:'complete',text:text.slice(17)}]});
 const rows=plainRows(await p.until(frame=>frame.includes('Opening request'),'excerpt'));await p.stop();
 const footer=rows.findIndex(row=>row.startsWith('↑↓ select'));
 // Two results take two rows; the details fill the rest of the body down to the blank row above the footer.
 assert.equal(rows[footer-2].endsWith(' …'),true,JSON.stringify(rows));
 const shown=joined(rows.slice(0,footer-1),'Opening request').replace(/ …$/u,'');
 assert.ok(text.startsWith(shown)&&shown.length>100,JSON.stringify(rows));
});
