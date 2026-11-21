import { constants } from 'node:fs';
import { lstat, open, realpath, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { HistoryItem, Session } from '../domain.js';
import { nativeIncarnation } from '../continuity.js';
import type { SessionAdapter } from './index.js';
import type { CodexDiagnostic, DiagnosticCode } from './codex-io.js';

export const openCodeNativeId = /^ses_[A-Za-z0-9]{1,200}$/;
export interface OpenCodeSession extends Session { createdAt:string; producerVersion:string }
export interface OpenCodeHistory { items:readonly HistoryItem[]; complete:boolean; diagnostics:readonly CodexDiagnostic[]; incarnation?:string; retained:false }
export interface OpenCodeAdapterOptions {
  dbPath?:string; root?:string; home?:string; env?:NodeJS.ProcessEnv;
  limits?:Partial<{maxDatabaseBytes:number;maxRows:number;maxTextBytes:number;maxDiagnostics:number}>;
  onDiagnostic?:(diagnostic:CodexDiagnostic)=>void;
}
/** 1.19.6 latest/beta/prod profile. Custom channels require an explicit database path. */
export function openCodePaths(options:OpenCodeAdapterOptions={}):{root:string;dbPath:string} {
  const env=options.env??process.env;
  const root=resolve(options.root??join(env.XDG_DATA_HOME||join(options.home??homedir(),'.local','share'),'opencode'));
  const chosen=options.dbPath??(env.OPENCODE_DB||'opencode.db');
  return {root,dbPath:chosen===':memory:'?chosen:isAbsolute(chosen)?chosen:join(root,chosen)};
}
// SessionV1.Part union at pinned 1.19.6 schema/v1/session.ts:357. These
// carriers are intentionally excluded from the public-text projection without reading payloads.
const excludedPartTypes=new Set(['subtask','reasoning','file','step-start','step-finish','snapshot','patch','agent','retry','compaction']);
const toolStates=new Set(['pending','running','completed','error']);
const defaults={maxDatabaseBytes:64*1024*1024,maxRows:10000,maxTextBytes:32*1024*1024,maxDiagnostics:100};
const key=(info:{dev:bigint;ino:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint})=>[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':');
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_]{1,220}$/.test(value);
const timestamp=(value:unknown):string=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000?new Date(value).toISOString():'';
const safeString=(value:unknown):value is string=>typeof value==='string'&&!value.includes('\0');

/** No DB copies, provider imports or native mutation PRAGMAs. Only a quiescent immutable 1.19.6 projection. */
export class OpenCodeSessionAdapter implements SessionAdapter {
  readonly id='opencode' as const;
  private readonly limits;
  private selected=new Map<string,OpenCodeSession>();
  private generation='';
  private pending:Promise<void>=Promise.resolve();
  constructor(private readonly options:OpenCodeAdapterOptions={}) {
    this.limits={...defaults,...options.limits};
    for(const [name,value] of Object.entries(this.limits))if(!Number.isSafeInteger(value)||value<1||value>defaults[name as keyof typeof defaults])throw new RangeError(`Invalid OpenCode limit: ${name}`);
  }
  private run<T>(fn:()=>Promise<T>):Promise<T> {const task=this.pending.then(fn);this.pending=task.then(()=>{},()=>{});return task;}
  private diagnostic(list:CodexDiagnostic[],code:DiagnosticCode):void {
    if(list.length>=this.limits.maxDiagnostics)return;
    const value:CodexDiagnostic={code,source:'history'};list.push(value);this.options.onDiagnostic?.(value);
  }
  private async physical():Promise<{path:string;signature:string;incarnation:string}> {
    const requested=openCodePaths(this.options).dbPath;
    if(requested===':memory:')throw new Error('unsupported-mode');
    const path=await realpath(requested),leaf=await lstat(requested,{bigint:true}),info=await lstat(path,{bigint:true});
    if(leaf.isSymbolicLink()||!info.isFile()||info.size<100||info.size>this.limits.maxDatabaseBytes)throw new Error(leaf.isSymbolicLink()?'unsafe-path':'input-limit');
    const parent=await lstat(dirname(path),{bigint:true});
    const name=basename(path);let entries=0;
    for await(const entry of await opendir(dirname(path))) {
      if(++entries>10000)throw new Error('input-limit');
      if(entry.name===name+'-wal'||entry.name===name+'-shm'||entry.name===name+'-journal'||entry.name.startsWith(name+'-mj'))throw new Error('unsupported-mode');
    }
    const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try {
      if(key(await handle.stat({bigint:true}))!==key(info))throw new Error('metadata-unstable');
      const header=Buffer.alloc(100);await handle.read(header,0,100,0);
      if(header.subarray(0,16).toString()!=='SQLite format 3\0')throw new Error('unsupported-shape');
    } finally {await handle.close();}
    return {path,signature:JSON.stringify([requested,path,key(leaf),key(info),key(parent)]),incarnation:nativeIncarnation({dev:Number(info.dev),ino:Number(info.ino),birthtimeMs:Number(info.birthtimeNs)/1e6})};
  }
  private async snapshot<T>(diagnostics:CodexDiagnostic[],read:(db:DatabaseSync)=>T):Promise<{value:T;signature:string;incarnation:string}|undefined> {
    let db:DatabaseSync|undefined;
    try {
      const before=await this.physical();
      // Node 22.15's SQLite opens URI filenames; immutable avoids sidecar/recovery writes and requires no WAL.
      db=new DatabaseSync(pathToFileURL(before.path).href+'?mode=ro&immutable=1',{readOnly:true});
      for(const [table,columns] of Object.entries({session:['id','directory','workspace_id','parent_id','title','version','time_created','time_updated','time_archived','revert'],message:['id','session_id','time_created','time_updated','data'],part:['id','message_id','session_id','time_created','time_updated','data']})) {
        const schema=db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(table);
        if(schema?.type!=='table'||typeof schema.sql!=='string'||/VIRTUAL/i.test(schema.sql))throw new Error('unsupported-shape');
        const actual=db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name);
        if(!columns.every(column=>actual.includes(column))||(table!=='session'&&actual.some(column=>!columns.includes(String(column)))))throw new Error('unsupported-shape');
      }
      const value=read(db);db.close();db=undefined;
      const after=await this.physical();
      if(before.signature!==after.signature)throw new Error('metadata-unstable');
      return {value,signature:after.signature,incarnation:after.incarnation};
    } catch(error) {
      const code=error instanceof Error?error.message:'';
      this.diagnostic(diagnostics,['unsafe-path','input-limit','unsupported-mode','unsupported-shape','metadata-unstable','invalid-boundary','selected-rollout-unavailable'].includes(code)?code as DiagnosticCode:'read-failed');
      return undefined;
    } finally {db?.close();}
  }
  discover():Promise<readonly OpenCodeSession[]> {return this.run(()=>this.catalog([]));}
  private async catalog(diagnostics:CodexDiagnostic[]):Promise<OpenCodeSession[]> {
    this.selected.clear();this.generation='';
    const snapshot=await this.snapshot(diagnostics,db=>db.prepare('SELECT id,directory,workspace_id,parent_id,title,version,time_created,time_updated,time_archived FROM session ORDER BY time_updated DESC,id LIMIT ?').all(this.limits.maxRows+1));
    if(!snapshot)return [];
    if(snapshot.value.length>this.limits.maxRows)this.diagnostic(diagnostics,'input-limit');
    for(const row of snapshot.value.slice(0,this.limits.maxRows)) {
      if(!openCodeNativeId.test(String(row.id))||!safeString(row.directory)||!isAbsolute(row.directory)||!safeString(row.title)||!timestamp(row.time_created)||!timestamp(row.time_updated)) {this.diagnostic(diagnostics,'malformed-record');continue;}
      if(row.version!=='1.19.6') {this.diagnostic(diagnostics,'untested-producer');continue;}
      // Child/archived/remote workspaces are deliberately outside the first local profile.
      if(row.workspace_id||row.parent_id||row.time_archived)continue;
      if(Buffer.byteLength(row.title)>4096||Buffer.byteLength(row.directory)>4096){this.diagnostic(diagnostics,'input-limit');continue;}
      let workspace=resolve(row.directory);try{workspace=await realpath(workspace);}catch{this.diagnostic(diagnostics,'workspace-unavailable');}
      const nativeId=String(row.id);
      this.selected.set(nativeId,{id:`opencode:${nativeId}`,nativeId,agent:'opencode',workspace,title:row.title,producerVersion:'1.19.6',createdAt:timestamp(row.time_created),updatedAt:timestamp(row.time_updated),messages:[]});
    }
    this.generation=snapshot.signature;
    return [...this.selected.values()];
  }
  async readHistory(id:string):Promise<readonly HistoryItem[]> {return (await this.readHistoryDetailed(id)).items;}
  readHistoryDetailed(id:string):Promise<OpenCodeHistory> {return this.readDetailed(id,true);}
  readCatalogHistoryDetailed(id:string):Promise<OpenCodeHistory> {return this.readDetailed(id,false);}
  private readDetailed(id:string,rediscover:boolean):Promise<OpenCodeHistory> {return this.run(async()=>{
    const diagnostics:CodexDiagnostic[]=[];
    if(rediscover)await this.catalog([]);
    if(!openCodeNativeId.test(id)||!this.selected.has(id)){this.diagnostic(diagnostics,'selected-rollout-unavailable');return {items:[],complete:false,diagnostics,retained:false};}
    const snapshot=await this.snapshot(diagnostics,db=>{
      const session=db.prepare(`SELECT json_valid(revert) AS valid,CASE WHEN json_valid(revert) THEN json_extract(revert,'$.messageID') END AS message,CASE WHEN json_valid(revert) THEN json_extract(revert,'$.partID') END AS part,revert IS NOT NULL AS reverted FROM session WHERE id=?`).get(id);
      if(!session)throw new Error('selected-rollout-unavailable');
      const messages=db.prepare(`SELECT id,time_created,json_valid(data) AS valid,CASE WHEN json_valid(data) THEN json_extract(data,'$.role') END AS role,CASE WHEN json_valid(data) THEN json_type(data,'$.time.completed')='integer' AND json_extract(data,'$.time.completed')>=0 END AS completed,CASE WHEN json_valid(data) THEN json_type(data,'$.error') END AS error FROM message WHERE session_id=? ORDER BY time_created,id LIMIT ?`).all(id,this.limits.maxRows+1);
      const parts=db.prepare(`SELECT p.id,p.message_id,json_valid(p.data) AS valid,
        CASE WHEN json_valid(p.data) THEN json_extract(p.data,'$.type') END AS type,
        CASE WHEN json_valid(p.data) THEN json_extract(p.data,'$.synthetic') END AS synthetic,
        CASE WHEN json_valid(p.data) THEN json_extract(p.data,'$.ignored') END AS ignored,
        CASE WHEN json_valid(p.data) THEN json_extract(p.data,'$.state.status') END AS status,
        CASE WHEN json_valid(p.data) AND json_extract(p.data,'$.type')='text' AND coalesce(json_extract(p.data,'$.synthetic'),0)=0 AND coalesce(json_extract(p.data,'$.ignored'),0)=0 AND json_type(p.data,'$.text')='text' THEN json_extract(p.data,'$.text')
             WHEN json_valid(p.data) AND json_extract(p.data,'$.type')='tool' AND json_extract(p.data,'$.state.status')='completed' AND json_type(p.data,'$.state.output')='text' THEN json_extract(p.data,'$.state.output')
             WHEN json_valid(p.data) AND json_extract(p.data,'$.type')='tool' AND json_extract(p.data,'$.state.status')='error' AND json_type(p.data,'$.state.error')='text' THEN json_extract(p.data,'$.state.error') END AS text
        FROM part p JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id WHERE p.session_id=? ORDER BY m.time_created,m.id,p.id LIMIT ?`).all(id,this.limits.maxRows+1);
      if(messages.length>this.limits.maxRows||parts.length>this.limits.maxRows)throw new Error('input-limit');
      if(session.reverted&&(!session.valid||!validId(session.message)||!messages.some(row=>row.id===session.message)||(session.part!==null&&(!validId(session.part)||!parts.some(row=>row.id===session.part&&row.message_id===session.message)))))throw new Error('invalid-boundary');
      const items:HistoryItem[]=[];let bytes=0;
      const boundary=messages.findIndex(row=>row.id===session.message);
      const positions=new Map(messages.map((row,index)=>[row.id,index]));
      const grouped=new Map(messages.map(row=>[row.id,row]));
      for(const row of messages)if(!row.valid||!validId(row.id)||!['user','assistant'].includes(String(row.role))||!timestamp(row.time_created))this.diagnostic(diagnostics,'malformed-record');
      for(const part of parts) {
        const message=grouped.get(part.message_id)!;
        if(session.reverted&&(positions.get(message.id)!>boundary||message.id===session.message&&!session.part||session.part===part.id))break;
        if(!part.valid||!validId(part.id)){this.diagnostic(diagnostics,'malformed-record');continue;}
        if(!message.valid||!validId(message.id)||!['user','assistant'].includes(String(message.role))||!timestamp(message.time_created))continue;
        if(typeof part.type==='string'&&excludedPartTypes.has(part.type))continue;
        if(part.type!=='text'&&part.type!=='tool'){this.diagnostic(diagnostics,'unsupported-shape');continue;}
        if(part.type==='text'&&(part.synthetic||part.ignored))continue;
        if(part.type==='tool') {
          if(typeof part.status!=='string'||!toolStates.has(part.status)){this.diagnostic(diagnostics,'unsupported-shape');continue;}
          if(part.status==='pending'||part.status==='running')continue;
        }
        if(!safeString(part.text)){this.diagnostic(diagnostics,'malformed-record');continue;}
        bytes+=Buffer.byteLength(part.text);if(bytes>this.limits.maxTextBytes)throw new Error('input-limit');
        if(!part.text)continue;
        items.push({id:`opencode:${id}:${message.id}:${part.id}`,role:part.type==='tool'?'tool':message.role as 'user'|'assistant',text:part.text,status:part.type==='tool'?part.status==='error'?'failed':'complete':message.role==='user'?'complete':message.error?'failed':message.completed?'complete':'interrupted'});
      }
      return items;
    });
    if(!snapshot||snapshot.signature!==this.generation){if(snapshot)this.diagnostic(diagnostics,'metadata-unstable');return {items:[],complete:false,diagnostics,retained:false};}
    return {items:snapshot.value,complete:diagnostics.length===0,diagnostics,incarnation:snapshot.incarnation,retained:false};
  });}
}
