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
/** `v2` sessions come from the 2.x `session_v2` store, whose `--session` creates a missing ID instead of failing. */
export interface OpenCodeSession extends Session { createdAt:string; producerVersion:string; store:'v1'|'v2' }
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
// 1.x keeps the session/message/part store; 2.x moved history to session_v2/session_message/session_part.
const openCodeProducer=/^1\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?$/;
export const testedOpenCodeProducer='1.19.6';
// A 2.x row's version is the creating build ('2.4.1', 'local'), or the copied 1.x string for migrated sessions and their forks.
const openCodeV2Version=/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
// Pinned v2.4.1 packages/schema/src/session-message.ts: message types and assistant part types without public text.
const excludedV2MessageTypes=new Set(['synthetic','system','skill','shell','compaction','idle','agent-switched','model-switched','location-switched']);
const v2ToolStates=new Set(['streaming','running','completed','error']);
const sessionColumns=['id','directory','workspace_id','parent_id','title','version','time_created','time_updated','time_archived','revert'];
const v1Tables={session:sessionColumns,message:['id','session_id','time_created','time_updated','data'],part:['id','message_id','session_id','time_created','time_updated','data']};
const v2Tables={session_v2:sessionColumns,session_message:['id','session_id','type','seq','data'],session_part:['message_id','session_id','ordinal','type','data']};
interface Stores { v1:boolean; v2:boolean; parts:boolean }
/** False when the table is absent; throws unless it has the required columns. 1.x message/part must match exactly; 2.x tables may grow. */
function columns(db:DatabaseSync,table:string,required:readonly string[],exact:boolean):boolean {
  const schema=db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(table);
  if(!schema)return false;
  if(schema.type!=='table'||typeof schema.sql!=='string'||/VIRTUAL/i.test(schema.sql))throw new Error('unsupported-shape');
  const actual=db.prepare(`PRAGMA table_info(${table})`).all().map(row=>String(row.name));
  if(!required.every(column=>actual.includes(column))||(exact&&actual.some(column=>!required.includes(column))))throw new Error('unsupported-shape');
  return true;
}
/** Only session_v2 identifies a 2.x store: 1.19.6 already has a session_message table. */
function stores(db:DatabaseSync):Stores {
  const v2=columns(db,'session_v2',v2Tables.session_v2,false);
  if(v2&&!columns(db,'session_message',v2Tables.session_message,false))throw new Error('unsupported-shape');
  // A fresh 2.x store has no 1.x tables; an upgraded one keeps them, and then they must still be the exact 1.x shape.
  const v1=columns(db,'session',v1Tables.session,false);
  if((v1||!v2)&&!(v1&&columns(db,'message',v1Tables.message,true)&&columns(db,'part',v1Tables.part,true)))throw new Error('unsupported-shape');
  return {v1,v2,parts:v2&&columns(db,'session_part',v2Tables.session_part,false)};
}
const assistantStatus=(message:Record<string,unknown>):HistoryItem['status']=>message.error?'failed':message.completed?'complete':'interrupted';
/** Bounded public text: every projected string counts toward the limit; empty text adds no item. */
function textItems(maxBytes:number) {
  const items:HistoryItem[]=[];let bytes=0;
  return {items,add(item:HistoryItem){bytes+=Buffer.byteLength(item.text);if(bytes>maxBytes)throw new Error('input-limit');if(item.text)items.push(item);}};
}
const group=<K,V>(map:Map<K,V[]>,key:K,value:V)=>{const list=map.get(key);if(list)list.push(value);else map.set(key,[value]);};

/** No DB copies, provider imports or native mutation PRAGMAs. Only a quiescent immutable 1.x projection, tested on 1.19.6. */
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
  private async snapshot<T>(diagnostics:CodexDiagnostic[],read:(db:DatabaseSync,stores:Stores)=>T):Promise<{value:T;signature:string;incarnation:string}|undefined> {
    let db:DatabaseSync|undefined;
    try {
      const before=await this.physical();
      // Node 22.15's SQLite opens URI filenames; immutable avoids sidecar/recovery writes and requires no WAL.
      db=new DatabaseSync(pathToFileURL(before.path).href+'?mode=ro&immutable=1',{readOnly:true});
      const value=read(db,stores(db));db.close();db=undefined;
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
    // A shared ID is the 1.x session that 2.x copied into session_v2; later turns go only to the 2.x copy.
    const listed=sessionColumns.filter(column=>column!=='revert').join(',');
    const snapshot=await this.snapshot(diagnostics,(db,{v1,v2})=>db.prepare([
      ...(v2?[`SELECT 'v2' AS store,${listed} FROM session_v2`]:[]),
      ...(v1?[`SELECT 'v1' AS store,${listed} FROM session${v2?' WHERE id NOT IN (SELECT id FROM session_v2)':''}`]:[]),
    ].join(' UNION ALL ')+' ORDER BY time_updated DESC,id LIMIT ?').all(this.limits.maxRows+1));
    if(!snapshot)return [];
    if(snapshot.value.length>this.limits.maxRows)this.diagnostic(diagnostics,'input-limit');
    let untested=false;
    for(const row of snapshot.value.slice(0,this.limits.maxRows)) {
      const store=row.store==='v2'?'v2':'v1',nativeId=String(row.id);
      // A 2.x title is nullable; like Codex, an untitled session is named after its ID until labelled.
      const title=store==='v2'&&row.title===null?`OpenCode ${nativeId}`:row.title;
      if(!openCodeNativeId.test(nativeId)||!safeString(row.directory)||!isAbsolute(row.directory)||!safeString(title)||!timestamp(row.time_created)||!timestamp(row.time_updated)) {this.diagnostic(diagnostics,'malformed-record');continue;}
      // Child/archived/remote workspaces are deliberately outside the first local profile. 2.x forks are top-level.
      if(row.workspace_id||row.parent_id||row.time_archived)continue;
      if(typeof row.version!=='string'||!(store==='v2'?openCodeV2Version:openCodeProducer).test(row.version)) {this.diagnostic(diagnostics,'unsupported-shape');continue;}
      // No real 2.x store has been inspected, so every 2.x session is untested whatever its version string.
      untested||=store==='v2'||row.version!==testedOpenCodeProducer;
      if(Buffer.byteLength(title)>4096||Buffer.byteLength(row.directory)>4096){this.diagnostic(diagnostics,'input-limit');continue;}
      let workspace=resolve(row.directory);try{workspace=await realpath(workspace);}catch{this.diagnostic(diagnostics,'workspace-unavailable');}
      this.selected.set(nativeId,{id:`opencode:${nativeId}`,nativeId,agent:'opencode',workspace,title,producerVersion:row.version,store,createdAt:timestamp(row.time_created),updatedAt:timestamp(row.time_updated),messages:[]});
    }
    if(untested)this.diagnostic(diagnostics,'untested-producer');
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
    const store=this.selected.get(id)!.store;
    const snapshot=await this.snapshot(diagnostics,(db,stores)=>{
      if(store==='v2')return this.historyV2(db,stores.parts,id,diagnostics);
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
      const {items,add}=textItems(this.limits.maxTextBytes);
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
        add({id:`opencode:${id}:${message.id}:${part.id}`,role:part.type==='tool'?'tool':message.role as 'user'|'assistant',text:part.text,status:part.type==='tool'?part.status==='error'?'failed':'complete':message.role==='user'?'complete':assistantStatus(message)});
      }
      return items;
    });
    if(!snapshot||snapshot.signature!==this.generation){if(snapshot)this.diagnostic(diagnostics,'metadata-unstable');return {items:[],complete:false,diagnostics,retained:false};}
    const complete=diagnostics.length===0;
    // Catalog reads skip the repeat: discovery already reported it once for the whole scan.
    if(rediscover&&(store==='v2'||this.selected.get(id)!.producerVersion!==testedOpenCodeProducer))this.diagnostic(diagnostics,'untested-producer');
    return {items:snapshot.value,complete,diagnostics,incarnation:snapshot.incarnation,retained:false};
  });}
  /** Public user requests of a 2.x session before any revert boundary, for an untitled label; 1.x sessions always have a title. */
  readCatalogTitleItems(id:string):Promise<readonly HistoryItem[]> {return this.run(async()=>{
    if(this.selected.get(id)?.store!=='v2')return [];
    const snapshot=await this.snapshot([],db=>db.prepare(`SELECT m.id,CASE WHEN NOT json_valid(m.data) THEN NULL WHEN json_type(m.data,'$.text')='text' THEN json_extract(m.data,'$.text') END AS text
      FROM session_message m JOIN session_v2 s ON s.id=m.session_id WHERE m.session_id=? AND m.type='user'
      AND (s.revert IS NULL OR m.seq<(SELECT b.seq FROM session_message b WHERE b.session_id=s.id AND b.id=CASE WHEN json_valid(s.revert) THEN json_extract(s.revert,'$.messageID') END))
      ORDER BY m.seq LIMIT 8`).all(id));
    return (snapshot?.value??[]).filter(row=>validId(row.id)&&safeString(row.text)).map(row=>({id:`opencode:${id}:${String(row.id)}`,role:'user' as const,text:row.text as string,status:'complete' as const}));
  });}
  /** 2.x projection (pinned v2.4.1 history.ts): messages by seq; an assistant's part rows by ordinal, then its inline content. */
  private historyV2(db:DatabaseSync,partRows:boolean,id:string,diagnostics:CodexDiagnostic[]):HistoryItem[] {
    const limit=this.limits.maxRows+1;
    const session=db.prepare(`SELECT revert IS NOT NULL AS reverted,json_valid(revert) AS valid,CASE WHEN json_valid(revert) THEN json_type(revert,'$.messageID') END AS type,CASE WHEN json_valid(revert) THEN json_extract(revert,'$.messageID') END AS message FROM session_v2 WHERE id=?`).get(id);
    if(!session)throw new Error('selected-rollout-unavailable');
    const messages=db.prepare(`SELECT id,type,seq,CASE WHEN json_valid(data) THEN json_type(data)='object' END AS valid,
      CASE WHEN NOT json_valid(data) OR type<>'user' THEN NULL WHEN json_type(data,'$.text')='text' THEN json_extract(data,'$.text') END AS text,
      CASE WHEN json_valid(data) THEN json_type(data,'$.content') END AS contentType,
      CASE WHEN json_valid(data) THEN json_type(data,'$.time.completed')='integer' AND json_extract(data,'$.time.completed')>=0 END AS completed,
      CASE WHEN json_valid(data) THEN json_type(data,'$.error') END AS error
      FROM session_message WHERE session_id=? ORDER BY seq,id LIMIT ?`).all(id,limit);
    // Each projected value is selected by JSON path, so private fields (input, metadata, native, error.response, files) are never read.
    const fields=(data:string,path:string,type:string)=>`${type} AS type,
      CASE WHEN ${type}='text' AND json_type(${data},${path}||'.text')='text' THEN json_extract(${data},${path}||'.text') END AS text,
      CASE WHEN ${type}='tool' THEN json_extract(${data},${path}||'.state.status') END AS status,
      CASE WHEN ${type}='tool' THEN json_type(${data},${path}||'.state.content') END AS contentType,
      CASE WHEN ${type}='tool' AND json_type(${data},${path}||'.state.error.message')='text' THEN json_extract(${data},${path}||'.state.error.message') END AS error`;
    const assistants=`(SELECT id,seq,CASE WHEN NOT json_valid(data) THEN '{"content":[]}' WHEN json_type(data,'$.content')='array' THEN data ELSE '{"content":[]}' END AS data FROM session_message WHERE session_id=? AND type='assistant')`;
    const rows=partRows?`(SELECT p.message_id,p.ordinal,p.type AS column_type,CASE WHEN json_valid(p.data) THEN json_type(p.data)='object' END AS valid,CASE WHEN json_valid(p.data) THEN p.data ELSE '{}' END AS data FROM session_part p JOIN session_message m ON m.id=p.message_id AND m.session_id=p.session_id WHERE p.session_id=? AND m.type='assistant')`:'';
    const parts=db.prepare([
      ...(rows?[`SELECT message_id AS message,0 AS source,ordinal AS position,valid,${fields('data',"'$'",'column_type')} FROM ${rows}`]:[]),
      `SELECT m.id AS message,1 AS source,CAST(c.key AS INTEGER) AS position,1 AS valid,${fields('m.data','c.fullkey',"json_extract(m.data,c.fullkey||'.type')")} FROM ${assistants} m,json_each(m.data,'$.content') c`,
    ].join(' UNION ALL ')+' ORDER BY 1,2,3 LIMIT ?').all(...(rows?[id]:[]),id,limit);
    const content=db.prepare([
      ...(rows?[`SELECT p.message_id AS message,0 AS source,p.ordinal AS position,json_extract(p.data,c.fullkey||'.type') AS type,CASE WHEN json_type(p.data,c.fullkey||'.text')='text' THEN json_extract(p.data,c.fullkey||'.text') END AS text FROM ${rows} p,json_each(p.data,'$.state.content') c WHERE p.column_type='tool' AND json_type(p.data,'$.state.content')='array'`]:[]),
      `SELECT m.id AS message,1 AS source,CAST(c.key AS INTEGER) AS position,json_extract(m.data,cc.fullkey||'.type') AS type,CASE WHEN json_type(m.data,cc.fullkey||'.text')='text' THEN json_extract(m.data,cc.fullkey||'.text') END AS text FROM ${assistants} m,json_each(m.data,'$.content') c,json_each(m.data,c.fullkey||'.state.content') cc WHERE json_extract(m.data,c.fullkey||'.type')='tool' AND json_type(m.data,c.fullkey||'.state.content')='array'`,
    ].join(' UNION ALL ')+' ORDER BY 1,2,3 LIMIT ?').all(...(rows?[id]:[]),id,limit);
    if(messages.length>this.limits.maxRows||parts.length>this.limits.maxRows||content.length>this.limits.maxRows)throw new Error('input-limit');
    // A staged revert hides its message and everything after it; upstream ignores the legacy partID.
    const boundary=session.reverted?messages.findIndex(row=>row.id===session.message):messages.length;
    if(session.reverted&&(!session.valid||session.type!=='text'||!validId(session.message)||boundary<0))throw new Error('invalid-boundary');
    const partKey=(row:Record<string,unknown>)=>`${String(row.message)}\0${String(row.source)}\0${String(row.position)}`;
    const partsOf=new Map<unknown,Record<string,unknown>[]>(),contentOf=new Map<string,Record<string,unknown>[]>();
    for(const part of parts)group(partsOf,part.message,part);
    for(const entry of content)group(contentOf,partKey(entry),entry);
    const {items,add}=textItems(this.limits.maxTextBytes);
    for(const message of messages.slice(0,boundary)) {
      if(!message.valid||!validId(message.id)||typeof message.type!=='string'||!Number.isSafeInteger(message.seq)){this.diagnostic(diagnostics,'malformed-record');continue;}
      if(excludedV2MessageTypes.has(message.type))continue;
      const base=`opencode:${id}:${message.id}`;
      if(message.type==='user') {
        if(!safeString(message.text)){this.diagnostic(diagnostics,'malformed-record');continue;}
        add({id:base,role:'user',text:message.text,status:'complete'});continue;
      }
      if(message.type!=='assistant'){this.diagnostic(diagnostics,'unsupported-shape');continue;}
      if(message.contentType!==null&&message.contentType!=='array')this.diagnostic(diagnostics,'malformed-record');
      const status=assistantStatus(message);
      for(const part of partsOf.get(message.id)??[]) {
        const partId=`${base}:${part.source?'c':'p'}${String(part.position)}`;
        if(!part.valid||!Number.isSafeInteger(part.position)){this.diagnostic(diagnostics,'malformed-record');continue;}
        if(part.type==='reasoning')continue;
        if(part.type==='text') {
          if(!safeString(part.text)){this.diagnostic(diagnostics,'malformed-record');continue;}
          add({id:partId,role:'assistant',text:part.text,status});continue;
        }
        if(part.type!=='tool'||typeof part.status!=='string'||!v2ToolStates.has(part.status)){this.diagnostic(diagnostics,'unsupported-shape');continue;}
        if(part.status==='streaming'||part.status==='running')continue;
        if(part.status==='error') {
          if(!safeString(part.error)){this.diagnostic(diagnostics,'malformed-record');continue;}
          add({id:partId,role:'tool',text:part.error,status:'failed'});continue;
        }
        if(part.contentType!=='array'){this.diagnostic(diagnostics,'malformed-record');continue;}
        // Completed output is text and file entries; file entries (URIs, media) never transfer.
        const texts:string[]=[];
        for(const entry of contentOf.get(partKey(part))??[]) {
          if(entry.type==='file')continue;
          if(entry.type!=='text'){this.diagnostic(diagnostics,'unsupported-shape');continue;}
          if(!safeString(entry.text)){this.diagnostic(diagnostics,'malformed-record');continue;}
          texts.push(entry.text);
        }
        add({id:partId,role:'tool',text:texts.join('\n'),status:'complete'});
      }
    }
    return items;
  }
}
