// Every invocation is a fresh OS process. Crash points are test-only trusted API
// boundaries, never CLI flags and never inferred provider acknowledgment.
import { TransferJournal } from '../../dist/transfer-journal.js';
const [directory,point]=process.argv.slice(2);const journal=await TransferJournal.open(directory);
if(point==='reopen') {console.log(JSON.stringify(journal.list()));journal.close();}
else {
 const record=journal.prepare({source:{agent:'codex',id:'synthetic',nativeId:'019a0000-0000-7000-8000-000000000001'},sourceKey:'fixture-source',target:'claude',workspace:'/synthetic',mode:'fresh-handoff',prompt:'consented redacted payload',includedItemIds:['u'],omittedItemIds:['a'],archive:null,completeness:'complete'});
 if(point==='prepared')process.exit(73);
 if(point==='deleting'){journal.beginDeletion(record.id);process.exit(73);}
 journal.begin(record.id);
 if(point==='pending')process.exit(73);
 journal.spawned(record.id,123456);
 if(point==='spawned'||point==='before-receipt')process.exit(73);
 if(point==='receipt-before-commit') {const exec=journal.db.exec.bind(journal.db);journal.db.exec=(sql)=>{if(sql==='COMMIT')process.exit(73);return exec(sql);};}
 journal.receipt(record.id,{attemptId:record.id,payloadHash:record.payloadHash,target:'claude',targetNativeId:'trusted-actual-target'});
 if(point==='accepted')process.exit(73);
 throw new Error('Unknown crash point');
}
