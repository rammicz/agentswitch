import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './fixtures/temp.mjs';

// Load inside each test so the initial missing-feature failure is retained as evidence.
const fixture = async () => {
 const { TransferJournal } = await import('../dist/transfer-journal.js');
 const root = await tempDir('agentswitch-journal-');
 return {root, journal:await TransferJournal.open(join(root,'journal'))};
};
const intent = () => ({ source:{agent:'codex',id:'codex:source',nativeId:'019a0000-0000-7000-8000-000000000001'}, sourceKey:'root+source',target:'claude',workspace:'/synthetic',mode:'fresh-handoff',prompt:'approved redacted prompt',includedItemIds:['u'],omittedItemIds:['a'],archive:null,completeness:'complete' });

test('durable pending reserves the source after restart; no receipt is inferred from exit',async()=>{
 const {root,journal}=await fixture();
 const prepared=journal.prepare(intent());
 journal.begin(prepared.id); journal.close();
 const {TransferJournal}=await import('../dist/transfer-journal.js');
 const reopened=await TransferJournal.open(join(root,'journal'));
 assert.equal(reopened.get(prepared.id).state,'pending');
 assert.equal(reopened.ownerState('root+source'),'unknown');
 assert.throws(()=>reopened.begin(reopened.prepare(intent()).id),/reserved/);
 reopened.exited(prepared.id,0,null);
 assert.equal(reopened.get(prepared.id).state,'uncertain');
 assert.equal(reopened.get(prepared.id).targetNativeId,null);
 assert.equal(reopened.ownerState('root+source'),'idle');
 reopened.abort(prepared.id);
 assert.equal(reopened.get(prepared.id).state,'uncertain');
 assert.equal(reopened.get(prepared.id).retired,true);
 assert.equal(reopened.ownerState('root+source'),'idle');
 reopened.close();
});

test('only correlated trusted receipts accept; receipt does not release writer ownership',async()=>{
 const {journal}=await fixture();const record=journal.prepare(intent());journal.begin(record.id);
 assert.throws(()=>journal.receipt(record.id,{attemptId:'wrong',payloadHash:record.payloadHash,target:'claude',targetNativeId:'actual-target'}),/receipt/);
 journal.receipt(record.id,{attemptId:record.id,payloadHash:record.payloadHash,target:'claude',targetNativeId:'actual-target'});
 assert.equal(journal.get(record.id).state,'accepted');assert.equal(journal.get(record.id).targetNativeId,'actual-target');
 assert.equal(journal.ownerState('root+source'),'unknown');journal.close();
});

test('explicit fresh retry is a new attempt; abort and deletion retain no payload',async()=>{
 const {journal,root}=await fixture(); const prior=journal.prepare(intent());journal.begin(prior.id);journal.exited(prior.id,7,null);
 const retry=journal.prepare({...intent(),retryOf:prior.id});journal.begin(retry.id);
 assert.notEqual(retry.id,prior.id);assert.equal(journal.get(prior.id).state,'uncertain');
 assert.throws(()=>journal.delete(retry.id),/writer/);
 journal.abort(prior.id);journal.delete(prior.id);
 assert.equal(journal.get(prior.id).deleted,true);assert.equal(journal.get(prior.id).prompt,undefined);
 assert.equal((await readFile(join(root,'journal','attempts.sqlite'))).includes(Buffer.from('approved redacted prompt')),true); // retry retains its own consented snapshot
 assert.equal((await stat(join(root,'journal'))).mode&0o777,0o700);
 assert.equal((await stat(join(root,'journal','attempts.sqlite'))).mode&0o777,0o600);journal.close();
});

test('deletion admission prevents prepared launch across database connections',async()=>{
 const {root,journal}=await fixture();const record=journal.prepare(intent());
 const {TransferJournal}=await import('../dist/transfer-journal.js');const sibling=await TransferJournal.open(join(root,'journal'));
 journal.beginDeletion(record.id);assert.throws(()=>sibling.begin(record.id),/replayed/);
 sibling.delete(record.id);assert.equal(journal.get(record.id).deleted,true);sibling.close();journal.close();
});

test('foreign entries, public permissions and symlink replacements are rejected',async()=>{
 const {journal,root}=await fixture();journal.close();const {TransferJournal}=await import('../dist/transfer-journal.js');
 const {chmod,rename,symlink,writeFile}=await import('node:fs/promises');
 const path=join(root,'journal','attempts.sqlite');await chmod(path,0o644);await assert.rejects(TransferJournal.open(join(root,'journal')),/private/);await chmod(path,0o600);
 await rename(path,path+'.saved');await symlink(path+'.saved',path);await assert.rejects(TransferJournal.open(join(root,'journal')),/dedicated|private/);
});

for(const point of ['prepared','pending','spawned','before-receipt','receipt-before-commit','accepted','deleting'])test(`process crash at ${point} preserves exact committed evidence and never replays`,async()=>{
 const {spawnSync}=await import('node:child_process');const root=await tempDir('agentswitch-crash-');const directory=join(root,'journal');
 const child=spawnSync(process.execPath,['test/fixtures/journal-crash.mjs',directory,point],{encoding:'utf8'});assert.equal(child.status,73,child.stderr);
 const reopen=spawnSync(process.execPath,['test/fixtures/journal-crash.mjs',directory,'reopen'],{encoding:'utf8'});assert.equal(reopen.status,0,reopen.stderr);
 const [record]=JSON.parse(reopen.stdout);assert.equal(record.source.nativeId,'019a0000-0000-7000-8000-000000000001');assert.deepEqual(record.includedItemIds,['u']);assert.deepEqual(record.omittedItemIds,['a']);
 assert.equal(record.state,['prepared','deleting'].includes(point)?'prepared':point==='accepted'?'accepted':'pending');assert.equal(record.targetNativeId,point==='accepted'?'trusted-actual-target':null);
 const {TransferJournal}=await import('../dist/transfer-journal.js');const journal=await TransferJournal.open(directory);assert.equal(journal.ownerState('fixture-source'),['prepared','deleting'].includes(point)?'idle':'unknown');journal.close();
});


test('deleting the sole payload erases retained content and excludes unknown draft/redaction properties',async()=>{
 const {journal,root}=await fixture();const record=journal.prepare({...intent(),prompt:'UNIQUE_CONSENTED_PUBLIC_CONTENT',redactions:['UNAPPROVED_SELECTION'],nativeAccount:'UNAPPROVED_NATIVE_FIELD'});
 journal.beginDeletion(record.id);journal.delete(record.id);journal.close();
 const bytes=await readFile(join(root,'journal','attempts.sqlite'));assert.equal(bytes.includes(Buffer.from('UNIQUE_CONSENTED_PUBLIC_CONTENT')),false);assert.equal(bytes.includes(Buffer.from('UNAPPROVED_SELECTION')),false);assert.equal(bytes.includes(Buffer.from('UNAPPROVED_NATIVE_FIELD')),false);
});
