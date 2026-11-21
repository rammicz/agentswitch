import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { TransferJournal } from '../dist/transfer-journal.js';
import { contextKey, chooseContinuation } from '../dist/continuity.js';
import { preparedContinuity, submit, stop, ref, token } from './fixtures/continuity-journal.mjs';
const directory=async()=>join(await mkdtemp(join(tmpdir(),'agentswitch-continuity-journal-')),'journal');
test('migration retains legacy accepted and uncertain outcomes without manufacturing lineage coverage',async()=>{
 const path=await directory(),journal=await TransferJournal.open(path);
 const input={source:{agent:'codex',id:'legacy',nativeId:'legacy'},sourceKey:'legacy',target:'claude',workspace:'/synthetic',mode:'fresh-handoff',prompt:'legacy approved content',includedItemIds:['legacy-item'],omittedItemIds:[],archive:null,completeness:'complete'};
 const accepted=journal.prepare(input);journal.begin(accepted.id);journal.receipt(accepted.id,{attemptId:accepted.id,payloadHash:accepted.payloadHash,target:'claude',targetNativeId:'legacy-native'});journal.exited(accepted.id,0,null);
 const uncertain=journal.prepare(input);journal.begin(uncertain.id);journal.exited(uncertain.id,0,null);const before=journal.list();journal.close();
 const db=new DatabaseSync(join(path,'attempts.sqlite'));db.exec('DROP TABLE contexts;DROP TABLE lineages;PRAGMA user_version=1;');db.close();
 const migrated=await TransferJournal.open(path);assert.deepEqual(migrated.list(),before);assert.deepEqual(migrated.contexts(),[]);migrated.close();
});
test('accepted receipt and exact coverage are atomic, idempotent and do not release native admission',async()=>{
 const path=await directory(),{journal,record,intent}=await preparedContinuity(path);journal.begin(record.id);submit(journal,record);stop(journal,record);stop(journal,record);
 const accepted=journal.get(record.id);assert.equal(accepted.state,'accepted');assert.equal(accepted.targetNativeId,'A');assert.equal(accepted.receiptTurnId,'turn-1');assert.equal(accepted.writer,'unknown');
 assert.throws(()=>journal.observe(record.id,token,{name:'SubagentStop',target:ref('codex','A'),turnId:'turn-1'}),/Unsupported/);
 const a=journal.contexts().find(context=>context.ref.nativeId==='A');assert.deepEqual(a.coveredIds,[...intent.includedItemIds,intent.continuity.requestId]);assert.ok(!a.coveredIds.includes(intent.omittedItemIds[0]));
 const lineage=journal.lineage(intent.continuity.lineage.id),items=Object.fromEntries([...intent.continuity.lineage.ids.map(id=>[id,{id,text:id,role:'user',status:'complete'}]),[intent.continuity.requestId,{id:intent.continuity.requestId,text:'current',role:'user',status:'complete'}]]);
 const next=chooseContinuation({context:intent.continuity.sourceContext,lineage,items:lineage.ids.map(id=>items[id])},[a],new Map([[contextKey(a.ref),a]]),'codex','/synthetic');assert.deepEqual(next.items.map(item=>item.id),intent.omittedItemIds);
 assert.equal(journal.ownerState('target:'+contextKey(ref('codex','A'))),'unknown');
 assert.throws(()=>journal.observe(record.id,token,{name:'Stop',target:ref('codex','A'),turnId:'other'}),/receipt/);
 journal.close();const reopened=await TransferJournal.open(path);assert.deepEqual(reopened.contexts().find(context=>context.ref.nativeId==='A'),a);assert.equal(reopened.get(record.id).state,'accepted');reopened.close();
});
for(const variation of ['wrong-token','wrong-root','replacement','wrong-native','wrong-hash','intervening-submit','retired','deleting','stale-epoch'])test(`${variation} never advances continuity coverage`,async()=>{
 const {journal,record}=await preparedContinuity(await directory());journal.begin(record.id);
 if(variation==='wrong-token')assert.throws(()=>journal.observe(record.id,'untrusted',{name:'UserPromptSubmit',target:ref('codex','A'),turnId:'turn-1',promptHash:record.payloadHash}));
 else if(['wrong-root','replacement','wrong-native'].includes(variation)) {const target={...ref('codex','A'),...(variation==='wrong-root'?{root:'wrong'}:variation==='replacement'?{incarnation:'replacement'}:{nativeId:'other'})};assert.throws(()=>submit(journal,record,target));}
 else {
  submit(journal,record);
  if(variation==='wrong-hash')journal.observe(record.id,token,{name:'UserPromptSubmit',target:ref('codex','A'),turnId:'turn-1',promptHash:'wrong'});
  if(variation==='intervening-submit')journal.observe(record.id,token,{name:'UserPromptSubmit',target:ref('codex','A'),turnId:'turn-2',promptHash:record.payloadHash});
  if(variation==='retired'||variation==='deleting') {journal.abort(record.id);if(variation==='deleting'){journal.exited(record.id,0,null);journal.beginDeletion(record.id);}}
  if(variation==='stale-epoch'){const row=journal.lineage(record.continuity.lineage.id);journal.db.prepare('UPDATE lineages SET data=? WHERE id=?').run(JSON.stringify({...row,epoch:row.epoch+1}),row.id);}
 }
 assert.throws(()=>stop(journal,record));assert.ok(journal.contexts().every(context=>context.coveredIds.length===0));assert.notEqual(journal.get(record.id).state,'accepted');journal.close();
});
test('independent source admissions serialize the same actual native A across handles and restart, including no child PID',async()=>{
 const path=await directory(),{journal,record,intent,seed}=await preparedContinuity(path);journal.begin(record.id);journal.close();
 const first=await TransferJournal.open(path),second=await TransferJournal.open(path);
 const competing=second.prepare({...intent,source:{...intent.source,nativeId:'C',id:'claude:C'},sourceKey:'independent-C'});
 assert.throws(()=>second.begin(competing.id),/Actual native target is reserved/);assert.equal(first.get(record.id).childPid,null);assert.equal(first.get(record.id).writer,'unknown');
 first.abort(seed.id);assert.throws(()=>first.beginDeletion(seed.id),/writer/);
 first.abort(record.id);assert.equal(second.ownerState('target:'+contextKey(ref('codex','A'))),'unknown');first.close();second.close();
});
for(const point of ['prepared','pending','submitted','receipt-before-commit','accepted'])test(`process death ${point} retains either old or fully accepted identity/turn/coverage`,async()=>{
 const path=await directory(),result=spawnSync(process.execPath,[resolve('test/fixtures/continuity-journal.mjs'),path,point],{encoding:'utf8'});assert.equal(result.status,73,result.stderr);
 const journal=await TransferJournal.open(path),[record]=journal.list(),a=journal.contexts().find(context=>context.ref.nativeId==='A');
 assert.equal(record.state,point==='prepared'?'prepared':point==='accepted'?'accepted':'pending');assert.equal(record.targetNativeId,point==='accepted'?'A':null);
 assert.equal(record.receiptTurnId,point==='accepted'?'turn-1':undefined);assert.deepEqual(a.coveredIds,point==='accepted'?[...record.includedItemIds,record.continuity.requestId]:[]);
 assert.equal(journal.ownerState('target:'+contextKey(ref('codex','A'))),point==='prepared'?'idle':'unknown');journal.close();
});
test('continuity deletion erases the sole approved delta, including after metadata retention',async()=>{
 const path=await directory(),{journal,record}=await preparedContinuity(path);journal.begin(record.id);journal.exited(record.id,0,null);journal.abort(record.id);journal.beginDeletion(record.id);journal.delete(record.id);journal.close();
 const bytes=await readFile(join(path,'attempts.sqlite'));assert.equal(bytes.includes(Buffer.from('exact B delta')),false);
});
