import { TransferJournal, digest } from '../../dist/transfer-journal.js';
import { observeContext } from '../../dist/continuity.js';
export const token='50000000-0000-4000-8000-000000000001';
export const ref=(agent,nativeId)=>({agent,nativeId,id:agent+':'+nativeId,root:agent+'-root',incarnation:nativeId+'-incarnation',workspace:'/synthetic',sourceKey:agent+'-source-'+nativeId});
const item=(id,text=id)=>({id,role:'user',text,status:'complete'});
export async function preparedContinuity(directory) {
 const journal=await TransferJournal.open(directory),a=observeContext({ref:ref('codex','A'),items:[item('a1'),item('a2')],retained:true},[],[],[]);
 const base={source:a.context.ref,sourceKey:a.context.ref.sourceKey,target:'claude',workspace:'/synthetic',mode:'fresh-handoff',prompt:'approved A context',includedItemIds:a.lineage.ids,omittedItemIds:[],archive:null,completeness:'complete',continuity:{lineage:a.lineage,baseRevision:0,sourceContext:a.context,targetRoot:'claude-root',targetRef:null,requestId:'request-a'}};
 const seed=journal.prepare(base);journal.begin(seed.id);journal.exited(seed.id,0,null);
 const b=observeContext({ref:ref('claude','B'),items:[item('b1'),item('b2')],retained:false},journal.contexts(),[],a.items,journal.lineage(a.lineage.id));
 const intent={...base,source:b.context.ref,sourceKey:b.context.ref.sourceKey,target:'codex',mode:'native-resume',prompt:'exact B delta',includedItemIds:[b.items.at(-2).id],omittedItemIds:[b.items.at(-1).id],observerTokenHash:digest(token),continuity:{lineage:b.lineage,baseRevision:b.baseRevision,sourceContext:b.context,targetRoot:'codex-root',targetRef:a.context.ref,requestId:'current-b'}};
 const record=journal.prepare(intent);
 return {journal,seed,record,intent,a,b};
}
export const submit=(journal,record,target=ref('codex','A'))=>journal.observe(record.id,token,{name:'UserPromptSubmit',target,turnId:'turn-1',promptHash:record.payloadHash});
export const stop=(journal,record,target=ref('codex','A'))=>journal.observe(record.id,token,{name:'Stop',target,turnId:'turn-1'});
export const checkpointPrompt=JSON.stringify({history:[],currentRequest:'Checkpoint current',omissions:{id:'50000000-0000-4000-8000-000000000002'}});
export const checkpointArchive={directory:'/synthetic',id:'50000000-0000-4000-8000-000000000002'};
export const checkpointSnapshot=record=>({ref:ref('codex','A'),retained:true,items:[item('a1'),item('a2'),item('echo',record.prompt),{...item('new-answer','UNAPPROVED_NATIVE_ANSWER_TEXT'),role:'assistant'}],itemTurns:['a1','a2','echo','new-answer'].map((id,index)=>({id,threadId:'A',turnId:index<2?'old-turn':'turn-1'}))});
if(process.argv[1]?.endsWith('/continuity-journal.mjs')) {
 const [directory,point]=process.argv.slice(2),{journal,record:ordinary,intent}=await preparedContinuity(directory);
 const record=point.startsWith('checkpoint')?journal.prepare({...intent,prompt:checkpointPrompt,archive:checkpointArchive}):ordinary;
 if(point==='prepared')process.exit(73);
 journal.begin(record.id);if(point==='pending')process.exit(73);
 if(point.startsWith('checkpoint'))journal.spawned(record.id,123456);
 submit(journal,record);if(point==='submitted')process.exit(73);
 if(point==='receipt-before-commit'){const exec=journal.db.exec.bind(journal.db);journal.db.exec=sql=>{if(sql==='COMMIT')process.exit(73);return exec(sql);};}
 stop(journal,record);
 if(point.startsWith('checkpoint')) {
  if(point==='checkpoint-before-commit'){const exec=journal.db.exec.bind(journal.db);journal.db.exec=sql=>{if(sql==='COMMIT')process.exit(73);return exec(sql);};}
  journal.checkpointAccepted(record.id,checkpointSnapshot(record));
 }
 process.exit(73);
}
