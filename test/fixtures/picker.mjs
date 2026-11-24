import { runPicker } from '../../dist/tui/app.js';
const workspace = process.env.PICKER_WORKSPACE;
const other = process.env.PICKER_OTHER;
const scenario = process.env.PICKER_SCENARIO;
const events = ['keypress','data','newListener','error'];
const before = events.map(event => process.stdin.listenerCount(event));
const listeners = () => events.map(event => process.stdin.listenerCount(event));
let reads=0;
const later = () => new Promise(r => setTimeout(r,250));
const hits = [
  { id:'one', nativeId:'n1', agent:'codex', title:'Alpha task', workspace, updatedAt:'2026-11-21', matches:[] },
  { id:'two', nativeId:'n2', agent:'claude', title:'Beta task', workspace, updatedAt:'2026-11-20', matches:[] },
  { id:'three', nativeId:'n3', agent:'claude', title:'Elsewhere task', workspace:other, updatedAt:'2026-11-19', matches:[] },
];
if (scenario === 'details') {
  hits[0].updatedAt = new Date(Date.now() - 18 * 60_000).toISOString();
  hits[1].updatedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
}
let prepared;
let calls=0;
try {
  await runPicker({ workspace, scope: scenario === 'global' || scenario === 'missing' ? 'global' : 'folder',
    ...(scenario === 'source-status' ? {notices: () => ['Codex source warning (untested-producer)']} : {}),
    ...(scenario === 'details' ? {details: async source => {
      if (source.id === 'one') await later();
      return [{id:source.id,role:'user',status:'complete',text: source.id === 'one' ? 'First opening request' : 'Second opening request'}];
    }} : {}),
    query: async (q) => {
      if (scenario === 'query-error' && reads++ === 0) throw Error('offline query failed');
      if (q.text === 'slow') { await later(); console.log('LATE QUERY'); }
      return hits.filter(s => (q.scope === 'global' || s.workspace === q.workspace) && (q.agent === 'all' || s.agent === q.agent) && (!q.text || q.text === 'needle' && s.id === 'two' || s.title.toLowerCase().includes(q.text.toLowerCase())))
        .map(s => ({...s,matches:q.text === 'needle' ? [{field:'message', itemId:'b7', role:'assistant',text:'the hidden needle'}] : []}));
    },
    preview: async (source) => {
      if (scenario === 'preview-error' && reads++ === 0) throw Error('offline preview failed');
      if (scenario === 'late-preview' || scenario === 'obsolete-preview') { await new Promise(r => setTimeout(r, scenario === 'obsolete-preview' ? 900 : 250)); console.log('LATE PREVIEW'); }
      if (scenario === 'transcript') return [
        {id:'u1',role:'user',status:'complete',text:'Please fix the flaky upload test.\nIt fails about once in ten runs on CI.'},
        {id:'a1',role:'assistant',status:'complete',text:'I will run the test in a loop first to reproduce the failure, then look at the retry logic in the upload worker.'},
        {id:'t1',role:'tool',status:'complete',text:['$ npm test -- --grep upload','','> agentswitch@0.1.0 test',...Array.from({length:8},(_,i)=>`ok ${i+1} - upload retries attempt ${i+1} ${'.'.repeat(120)}`),'# pass 8'].join('\n')},
        {id:'a2',role:'assistant',status:'interrupted',text:'The retry delay is computed from the wrong clock.'},
        {id:'t2',role:'tool',status:'failed',text:'Error: command exited with code 1'},
      ];
      return [{id:source.id === 'two' ? 'b7':'a1',role:'assistant',text:'Public transcript needle',status:'complete'}];
    },
    // Stands in for the service decision; the real rule is tested through the application.
    outcome: async request => request.target === request.source.agent && !request.fresh
      ? { native: true, text: `Resumes the original ${request.target} session natively.` }
      : { native: false, text: `Starts ${request.target} with a handoff of this conversation.` },
    prepare: async (request) => {
      if (scenario === 'prepare-error' && reads++ === 0) throw Error('offline preparation failed');
      if (scenario === 'late-prepare') { await later(); console.log('LATE PREPARE'); }
      prepared={opaque:'exact-object',request};
      return {plan:prepared,summary:{source:request.source,target:request.target,mode:scenario === 'native' ? 'native-resume' : 'fresh-handoff',workspace:request.workspace.path,includedItemIds:['b7'],omittedItemIds:['old1','old2']}};
    },
    continue: async (plan) => {
      calls++;
      console.log('DISPATCH '+JSON.stringify({calls,exact:plan === prepared,raw:process.stdin.isRaw,plan}));
      if (scenario === 'callback-error') throw Error('offline callback failed');
    },
  });
  console.log('DONE '+JSON.stringify({calls,raw:process.stdin.isRaw,listeners:listeners(),before}));
} catch(error) {console.log('ERROR '+error.message+' '+JSON.stringify({calls,raw:process.stdin.isRaw,listeners:listeners(),before}));}
