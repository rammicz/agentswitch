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
let prepared;
let calls=0;
try {
  await runPicker({ workspace, scope: scenario === 'global' || scenario === 'missing' ? 'global' : 'folder',
    query: async (q) => {
      if (scenario === 'query-error' && reads++ === 0) throw Error('offline query failed');
      if (q.text === 'slow') { await later(); console.log('LATE QUERY'); }
      return hits.filter(s => (q.scope === 'global' || s.workspace === q.workspace) && (q.agent === 'all' || s.agent === q.agent) && (!q.text || q.text === 'needle' && s.id === 'two' || s.title.toLowerCase().includes(q.text.toLowerCase())))
        .map(s => ({...s,matches:q.text === 'needle' ? [{field:'message', itemId:'b7', role:'assistant',text:'the hidden needle'}] : []}));
    },
    preview: async (source) => {
      if (scenario === 'preview-error' && reads++ === 0) throw Error('offline preview failed');
      if (scenario === 'late-preview' || scenario === 'obsolete-preview') { await new Promise(r => setTimeout(r, scenario === 'obsolete-preview' ? 900 : 250)); console.log('LATE PREVIEW'); }
      return [{id:source.id === 'two' ? 'b7':'a1',role:'assistant',text:'Public transcript needle',status:'complete'}];
    },
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
