import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, readFileSync, readdirSync, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentId } from './domain.js';
import type { ArchiveReference } from './archive.js';
import type { SessionSource } from './tui/contracts.js';
import { contextKey, type ContextRef, type ContinuityIntent, type Lineage, type NativeContext } from './continuity.js';

export interface TransferIntent {
  source: SessionSource;
  /** Nonreversible digest of canonical native roots and source identity. */
  sourceKey: string;
  target: AgentId;
  workspace: string;
  mode: 'native-resume' | 'fresh-handoff';
  /** Exact consented redacted wire value, never original drafts or redaction selections. */
  prompt: string;
  includedItemIds: readonly string[];
  omittedItemIds: readonly string[];
  archive: ArchiveReference | null;
  completeness: 'complete' | 'partial' | 'unknown';
  retryOf?: string;
  continuity?: ContinuityIntent;
  observerTokenHash?: string;
}
export interface TransferRecord extends Omit<TransferIntent, 'prompt'> {
  version: 1; id: string; prompt?: string; payloadHash: string;
  state: 'prepared' | 'pending' | 'accepted' | 'uncertain' | 'failed';
  createdAt: string; updatedAt: string; targetNativeId: string | null;
  launch: 'not-started' | 'possible' | 'observed' | 'not-launched';
  writer: 'not-started' | 'unknown' | 'stopped';
  parentPid: number | null; childPid: number | null;
  exit: { code: number | null; signal: string | null } | null;
  retired: boolean; deleted: boolean; deleting: boolean;
  observation?: { target:ContextRef; turnId:string; conflicted:boolean };
  receiptTurnId?:string;
}
/** Only trusted adapters may supply this; stdout, exit status and terminal ACKs are not receipts. */
export interface TrustedReceipt { attemptId: string; payloadHash: string; target: AgentId; targetNativeId: string; targetRef?:ContextRef; turnId?:string }
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const marker = 'agentswitch-transfer-journal-v1\n';
const allowed = new Set(['owner', 'attempts.sqlite', 'attempts.sqlite-journal']);
function privateEntry(info: Stats, directory: boolean): void {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw new Error('Transfer journal must be private, owned and without symbolic links.');
}
function metadataIntent(input:ContinuityIntent):ContinuityIntent {
  const ref=(value:ContextRef):ContextRef=>({agent:value.agent,id:value.id,nativeId:value.nativeId,root:value.root,incarnation:value.incarnation,workspace:value.workspace,sourceKey:value.sourceKey});
  const lineage=input.lineage,context=input.sourceContext;
  return {lineage:{id:lineage.id,epoch:lineage.epoch,revision:lineage.revision,ids:[...lineage.ids],excludedIds:[...lineage.excludedIds??[]]},baseRevision:input.baseRevision,targetRoot:input.targetRoot,targetRef:input.targetRef?ref(input.targetRef):null,requestId:input.requestId,
    sourceContext:{ref:ref(context.ref),lineageId:context.lineageId,epoch:context.epoch,nativeItems:context.nativeItems.map(item=>({id:item.id,revision:item.revision,ids:[...item.ids]})),ownIds:[...context.ownIds],coveredIds:[...context.coveredIds],retained:context.retained,acceptedAttempts:[...context.acceptedAttempts??[]]}};
}

/** SQLite FULL commits make admission and intent one durable cross-process transaction. */
export class TransferJournal {
  private constructor(private readonly directory: string, private readonly db: DatabaseSync, private readonly identity: Stats) {}
  static async open(path: string): Promise<TransferJournal> {
    const directory = resolve(path);
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    privateEntry(await lstat(directory), true);
    for (const name of await readdir(directory)) { if (!allowed.has(name)) throw new Error('Use a dedicated transfer journal directory.'); try {privateEntry(await lstat(join(directory, name)), false);}catch(error){if(name!=='attempts.sqlite-journal'||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;} }
    try { const file = await open(join(directory, 'owner'), 'wx', 0o600); try { await file.writeFile(marker); await file.sync(); } finally { await file.close(); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (await readFile(join(directory, 'owner'), 'utf8') !== marker) throw new Error('Invalid transfer journal ownership marker.');
    const filename = join(directory, 'attempts.sqlite');
    try { const file = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await file.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const identity = await lstat(filename); privateEntry(identity, false);
    const db = new DatabaseSync(filename);
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY;');
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2) throw new Error('Unsupported transfer journal version.');
      // Migration adds metadata only. Existing outcomes are never promoted to coverage.
      db.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS reservations (key TEXT PRIMARY KEY, attempt TEXT NOT NULL); CREATE TABLE IF NOT EXISTS contexts (key TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS lineages (id TEXT PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version=2; COMMIT;');
      const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } catch (error) { if (process.platform !== 'darwin' || !['EINVAL','ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; } finally { await handle.close(); }
      return new TransferJournal(directory, db, identity);
    } catch (error) { db.close(); throw error; }
  }
  private current(): void {
    privateEntry(lstatSync(this.directory), true);
    for (const name of readdirSync(this.directory)) { if (!allowed.has(name)) throw new Error('Foreign transfer journal entry.'); try {privateEntry(lstatSync(join(this.directory,name)), false);}catch(error){if(name!=='attempts.sqlite-journal'||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;} }
    const info = lstatSync(join(this.directory,'attempts.sqlite')); privateEntry(info,false);
    if (info.dev !== this.identity.dev || info.ino !== this.identity.ino || readFileSync(join(this.directory,'owner'),'utf8') !== marker) throw new Error('Transfer journal replaced; reopen it.');
  }
  private transaction<T>(work: () => T): T {
    this.current(); this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private save(record: TransferRecord): void {
    record.updatedAt = new Date().toISOString();
    this.db.prepare('INSERT OR REPLACE INTO attempts(id,data) VALUES (?,?)').run(record.id, JSON.stringify(record));
  }
  get(id: string): TransferRecord {
    this.current(); const row = this.db.prepare('SELECT data FROM attempts WHERE id=?').get(id);
    if (!row) throw new Error('Transfer not found.');
    return JSON.parse(row.data as string) as TransferRecord;
  }
  list(): TransferRecord[] { this.current(); return this.db.prepare('SELECT data FROM attempts ORDER BY rowid DESC').all().map(row => JSON.parse(row.data as string) as TransferRecord); }
  prepare(input: TransferIntent): TransferRecord {
    return this.transaction(() => {
      if (input.retryOf) { const prior=this.get(input.retryOf); if (prior.deleted || prior.deleting || prior.sourceKey !== input.sourceKey || input.mode !== 'fresh-handoff') throw new Error('Recovery requires an existing transfer and a new fresh context.'); }
      const now=new Date().toISOString();
      const record: TransferRecord={source:{agent:input.source.agent,id:input.source.id,nativeId:input.source.nativeId},sourceKey:input.sourceKey,target:input.target,workspace:input.workspace,mode:input.mode,prompt:input.prompt,includedItemIds:[...input.includedItemIds],omittedItemIds:[...input.omittedItemIds],archive:input.archive?{directory:input.archive.directory,id:input.archive.id}:null,completeness:input.completeness,...(input.retryOf?{retryOf:input.retryOf}:{}),version:1,id:randomUUID(),payloadHash:digest(input.prompt),state:'prepared',createdAt:now,updatedAt:now,targetNativeId:null,launch:'not-started',writer:'not-started',parentPid:null,childPid:null,exit:null,retired:false,deleted:false,deleting:false};
      if(input.continuity)record.continuity=metadataIntent(input.continuity);
      if(input.observerTokenHash&&/^[a-f0-9]{64}$/.test(input.observerTokenHash))record.observerTokenHash=input.observerTokenHash;
      this.save(record);return record;
    });
  }
  ownerState(sourceKey: string, ownedAttempt?: string): 'idle' | 'unknown' {
    this.current(); const reservation=this.db.prepare('SELECT attempt FROM reservations WHERE key=?').get(sourceKey);return reservation&&reservation.attempt!==ownedAttempt ? 'unknown' : 'idle';
  }
  begin(id: string): TransferRecord {
    return this.transaction(() => {
      const record=this.get(id);
      if(record.state!=='prepared' || record.retired || record.deleted || record.deleting) throw new Error('Transfer cannot be replayed. Prepare and confirm a new attempt.');
      // An explicit fresh recovery may overlap an unresolved old target, never its native conversation.
      const key=record.retryOf ? `retry:${record.retryOf}` : record.sourceKey;
      if(this.db.prepare('SELECT attempt FROM reservations WHERE key=?').get(key)) throw new Error('Source is reserved by an earlier attempt. Review recovery and explicitly choose a fresh retry.');
      const targetKey=record.continuity?.targetRef?`target:${contextKey(record.continuity.targetRef)}`:null;
      if(targetKey&&this.db.prepare('SELECT attempt FROM reservations WHERE key=?').get(targetKey))throw new Error('Actual native target is reserved by an earlier attempt.');
      if(record.continuity) {
        const continuity=record.continuity,previous=this.lineage(continuity.lineage.id);
        if((previous?.revision??0)!==continuity.baseRevision)throw new Error('Lineage changed after preview. Prepare and confirm again.');
        this.db.prepare('INSERT OR REPLACE INTO lineages(id,data) VALUES (?,?)').run(continuity.lineage.id,JSON.stringify(continuity.lineage));
        this.saveContext(continuity.sourceContext);
      }
      for(const reservation of new Set([key,...(targetKey?[targetKey]:[])]))this.db.prepare('INSERT INTO reservations(key,attempt) VALUES (?,?)').run(reservation,id);
      record.state='pending';record.launch='possible';record.writer='unknown';record.parentPid=process.pid;this.save(record);return record;
    });
  }
  spawned(id: string, childPid: number): void { this.transaction(()=>{ const record=this.get(id); if(record.state!=='pending') throw new Error('Transfer is not pending.');record.launch='observed';record.childPid=childPid;this.save(record); }); }
  exited(id: string, code: number | null, signal: string | null): void {
    this.transaction(()=>{const record=this.get(id);if(!['pending','accepted'].includes(record.state)) throw new Error('Transfer is not running.');if(record.state!=='accepted') record.state='uncertain';record.exit={code,signal};
      // A supervised close releases only this attempt's writer admission, never its uncertain delivery outcome.
      record.writer='stopped';this.db.prepare('DELETE FROM reservations WHERE attempt=?').run(id);this.save(record);});
  }
  failedBeforeSpawn(id: string): void { this.transaction(()=>{const record=this.get(id);if(record.launch==='observed') throw new Error('Delivery may have started.');record.state='failed';record.launch='not-launched';record.writer='stopped';this.db.prepare('DELETE FROM reservations WHERE attempt=?').run(id);this.save(record);}); }
  uncertain(id: string): void { this.transaction(()=>{const record=this.get(id);if(record.state!=='accepted') record.state='uncertain';this.save(record);}); }
  receipt(id: string, receipt: TrustedReceipt): void {
    this.transaction(()=>{const record=this.get(id);
      this.accept(record,receipt);});
  }
  contexts():NativeContext[] {this.current();return this.db.prepare('SELECT data FROM contexts').all().map(row=>JSON.parse(row.data as string) as NativeContext);}
  lineage(id:string):Lineage|undefined {this.current();const row=this.db.prepare('SELECT data FROM lineages WHERE id=?').get(id);return row?JSON.parse(row.data as string) as Lineage:undefined;}
  private saveContext(context:NativeContext):void {this.db.prepare('INSERT OR REPLACE INTO contexts(key,data) VALUES (?,?)').run(contextKey(context.ref),JSON.stringify(context));}
  private accept(record:TransferRecord,receipt:TrustedReceipt):void {
    if(record.retired||record.deleted||record.deleting||!['pending','uncertain','accepted'].includes(record.state)||receipt.attemptId!==record.id||receipt.payloadHash!==record.payloadHash||receipt.target!==record.target||typeof receipt.targetNativeId!=='string'||!receipt.targetNativeId||receipt.targetNativeId.length>4096||/[\x00-\x1f\x7f-\x9f]/.test(receipt.targetNativeId))throw new Error('Uncorrelated or invalid trusted receipt.');
    const continuity=record.continuity;
    if(continuity) {
      const actual=receipt.targetRef,observation=record.observation,lineage=this.lineage(continuity.lineage.id);
      if(!actual||!observation||observation.conflicted||!receipt.turnId||receipt.turnId!==observation.turnId||contextKey(actual)!==contextKey(observation.target)||actual.agent!==record.target||actual.root!==continuity.targetRoot||actual.nativeId!==receipt.targetNativeId||actual.workspace!==record.workspace||lineage?.epoch!==continuity.lineage.epoch||record.includedItemIds.some(id=>!lineage.ids.includes(id))||(continuity.targetRef&&contextKey(continuity.targetRef)!==contextKey(actual)))throw new Error('Uncorrelated continuity receipt.');
      if(record.state==='accepted') {if(record.targetNativeId!==actual.nativeId||record.receiptTurnId!==receipt.turnId)throw new Error('Conflicting receipt.');return;}
      const existing=this.contexts().find(context=>contextKey(context.ref)===contextKey(actual));
      if(existing&&(existing.lineageId!==lineage.id||existing.epoch!==lineage.epoch))throw new Error('Native target lineage changed.');
      this.saveContext({ref:actual,lineageId:lineage.id,epoch:lineage.epoch,nativeItems:existing?.nativeItems??[],ownIds:existing?.ownIds??[],coveredIds:[...new Set([...(existing?.coveredIds??[]),...record.includedItemIds,continuity.requestId])],retained:true,acceptedAttempts:[...new Set([...(existing?.acceptedAttempts??[]),record.id])]});
      // A successfully completed current request is a new eligible activity, not imported history.
      if(!lineage.ids.includes(continuity.requestId))this.db.prepare('UPDATE lineages SET data=? WHERE id=?').run(JSON.stringify({...lineage,revision:lineage.revision+1,ids:[...lineage.ids,continuity.requestId]}),lineage.id);
      record.receiptTurnId=receipt.turnId;
    } else if(record.state==='accepted') {if(record.targetNativeId!==receipt.targetNativeId)throw new Error('Conflicting receipt.');return;}
    record.state='accepted';record.targetNativeId=receipt.targetNativeId;this.save(record);
  }
  /** Called only by the bounded native-hook adapter; never interprets provider stdout. */
  observe(id:string,token:string,event:{name:'UserPromptSubmit'|'Stop';target:ContextRef;turnId:string;promptHash?:string}):void {
    this.transaction(()=>{
      const record=this.get(id),continuity=record.continuity;
      if(!continuity||record.target!=='codex'||record.observerTokenHash!==digest(token)||record.retired||record.deleted||record.deleting||!['pending','uncertain','accepted'].includes(record.state)||event.target.agent!==record.target||event.target.root!==continuity.targetRoot||event.target.workspace!==record.workspace||(continuity.targetRef&&contextKey(continuity.targetRef)!==contextKey(event.target))||!event.turnId||event.turnId.length>256||/[\x00-\x1f\x7f-\x9f]/.test(event.turnId))throw new Error('Invalid native observation.');
      if(event.name==='UserPromptSubmit') {
        const same=record.observation&&contextKey(record.observation.target)===contextKey(event.target)&&record.observation.turnId===event.turnId;
        if(record.state==='accepted')return;
        if(event.promptHash!==record.payloadHash||record.observation&&!same) {
          record.observation={target:event.target,turnId:event.turnId,conflicted:true};this.save(record);return;
        }
        record.observation??={target:event.target,turnId:event.turnId,conflicted:false};this.save(record);return;
      }
      this.accept(record,{attemptId:id,payloadHash:record.payloadHash,target:'codex',targetNativeId:event.target.nativeId,targetRef:event.target,turnId:event.turnId});
    });
  }
  abort(id: string): void { this.transaction(()=>{const record=this.get(id);record.retired=true;this.save(record);}); }
  private invalidateLineage(record:TransferRecord):void {
    if(!record.continuity)return;
    const lineage=this.lineage(record.continuity.lineage.id);if(!lineage)return;
    this.db.prepare('UPDATE lineages SET data=? WHERE id=?').run(JSON.stringify({...lineage,epoch:lineage.epoch+1,revision:lineage.revision+1,ids:[],excludedIds:[...new Set([...(lineage.excludedIds??[]),...lineage.ids])]}),lineage.id);
    this.db.prepare('DELETE FROM contexts WHERE json_extract(data,\'$.lineageId\')=?').run(lineage.id);
  }
  assertDeletable(id: string): TransferRecord { const record=this.get(id);if(record.writer==='unknown'||record.continuity&&this.list().some(other=>other.continuity?.lineage.id===record.continuity!.lineage.id&&other.writer==='unknown')) throw new Error('Cannot delete while a writer may still use the archive. Stop and verify the owner first; no lease was stolen.');return record; }
  beginDeletion(id: string): TransferRecord { return this.transaction(()=>{const record=this.assertDeletable(id);if(!record.retired&&!['prepared','failed'].includes(record.state))throw new Error('Abort the transfer before artifact deletion.');if(!record.deleting)this.invalidateLineage(record);record.deleting=true;record.retired=true;this.save(record);return record;}); }
  delete(id: string): void { this.transaction(()=>{const record=this.assertDeletable(id);if(!record.retired && !['prepared','failed'].includes(record.state)) throw new Error('Abort the transfer before artifact deletion.');
    if(!record.deleting&&!record.deleted)this.invalidateLineage(record);
    // Minimal non-sensitive tombstone preserves the source reservation without replayable content.
    delete record.prompt;delete record.continuity;delete record.observation;delete record.observerTokenHash;delete record.receiptTurnId;record.source={agent:record.source.agent,id:'deleted',nativeId:'deleted'};record.workspace='';record.archive=null;record.includedItemIds=[];record.omittedItemIds=[];record.targetNativeId=null;record.deleted=true;record.deleting=false;this.save(record);}); }
  close(): void { this.db.close(); }
}
