import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, readFileSync, readdirSync, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentId } from './domain.js';
import type { ArchiveReference } from './archive.js';
import type { SessionSource } from './tui/contracts.js';

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
}
/** Only trusted adapters may supply this; stdout, exit status and terminal ACKs are not receipts. */
export interface TrustedReceipt { attemptId: string; payloadHash: string; target: AgentId; targetNativeId: string }
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const marker = 'agentswitch-transfer-journal-v1\n';
const allowed = new Set(['owner', 'attempts.sqlite', 'attempts.sqlite-journal']);
function privateEntry(info: Stats, directory: boolean): void {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw new Error('Transfer journal must be private, owned and without symbolic links.');
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
      if (version !== 0 && version !== 1) throw new Error('Unsupported transfer journal version.');
      db.exec('CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS reservations (key TEXT PRIMARY KEY, attempt TEXT NOT NULL); PRAGMA user_version=1;');
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
      this.db.prepare('INSERT INTO reservations(key,attempt) VALUES (?,?)').run(key,id);
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
      if(!['pending','uncertain'].includes(record.state) || receipt.attemptId!==id || receipt.payloadHash!==record.payloadHash || receipt.target!==record.target || typeof receipt.targetNativeId!=='string' || !receipt.targetNativeId || receipt.targetNativeId.length>4096 || /[\x00-\x1f\x7f-\x9f]/.test(receipt.targetNativeId)) throw new Error('Uncorrelated or invalid trusted receipt.');
      record.state='accepted';record.targetNativeId=receipt.targetNativeId;this.save(record);});
  }
  abort(id: string): void { this.transaction(()=>{const record=this.get(id);record.retired=true;this.save(record);}); }
  assertDeletable(id: string): TransferRecord { const record=this.get(id);if(record.writer==='unknown') throw new Error('Cannot delete while a writer may still use the archive. Stop and verify the owner first; no lease was stolen.');return record; }
  beginDeletion(id: string): TransferRecord { return this.transaction(()=>{const record=this.assertDeletable(id);if(!record.retired&&!['prepared','failed'].includes(record.state))throw new Error('Abort the transfer before artifact deletion.');record.deleting=true;record.retired=true;this.save(record);return record;}); }
  delete(id: string): void { this.transaction(()=>{const record=this.assertDeletable(id);if(!record.retired && !['prepared','failed'].includes(record.state)) throw new Error('Abort the transfer before artifact deletion.');
    // Minimal non-sensitive tombstone preserves the source reservation without replayable content.
    delete record.prompt;record.source={agent:record.source.agent,id:'deleted',nativeId:'deleted'};record.workspace='';record.archive=null;record.includedItemIds=[];record.omittedItemIds=[];record.targetNativeId=null;record.deleted=true;record.deleting=false;this.save(record);}); }
  close(): void { this.db.close(); }
}
