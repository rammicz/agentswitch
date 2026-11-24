import { constants } from 'node:fs';
import { lstat, open, realpath, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseAgyHistory } from './agy-history.js';
import type { Session, HistoryItem } from '../domain.js';
import type { SessionAdapter } from './index.js';
import type { CodexDiagnostic } from './codex-io.js';
import { contains } from './codex-io.js';

export const agyNativeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface AgySession extends Session { readonly metadataOnly:boolean }
export interface AgyHistory { items:readonly HistoryItem[]; complete:boolean; retained:false; incarnation?:string; snapshotIdentity?:string; excludedSteps?:readonly number[]; diagnostics:readonly CodexDiagnostic[] }
export interface AgyAdapterOptions {
  root?:string; home?:string; env?:NodeJS.ProcessEnv;
  limits?:Partial<typeof defaults>;
  onDiagnostic?:(diagnostic:CodexDiagnostic)=>void;
}
/** App-specific root override; native GEMINI_HOME behavior is not inferred. */
export function agyPaths(options:AgyAdapterOptions={}):{root:string;cache:string} {
  const env=options.env??process.env;
  const root=resolve(options.root??(env.AGENTSWITCH_AGY_ROOT?.trim()||join(options.home??homedir(),'.gemini','antigravity-cli')));
  return {root,cache:join(root,'cache','last_conversations.json')};
}
const defaults={
  maxBytes:1024*1024,maxEntries:1000,maxDiagnostics:100,
  maxDatabaseBytes:64*1024*1024,maxFileBytes:32*1024*1024,maxLineBytes:1024*1024,
  maxItems:100000,maxScanBytes:256*1024*1024,maxFiles:10000,
};
const identity=(info:{dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number}):string=>JSON.stringify([info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs]);

/** Quiescent local public-text projection and sparse cache fallback. Never starts ACP or reads credentials. */
export class AgySessionAdapter implements SessionAdapter {
  readonly id='agy' as const;
  private readonly limits;
  constructor(private readonly options:AgyAdapterOptions={}) {
    this.limits={...defaults,...options.limits};
    for(const [name,value] of Object.entries(this.limits))if(!Number.isSafeInteger(value)||value<1||value>defaults[name as keyof typeof defaults])throw new RangeError(`Invalid agy limit: ${name}`);
  }
  private diagnostic(list:CodexDiagnostic[],code:CodexDiagnostic['code'],source:CodexDiagnostic['source']='metadata'):void {
    if(list.length>=this.limits.maxDiagnostics)return;
    const value:CodexDiagnostic={code,source};list.push(value);this.options.onDiagnostic?.(value);
  }
  private async cached():Promise<{sessions:readonly AgySession[];ambiguous:ReadonlySet<string>}> {
    const diagnostics:CodexDiagnostic[]=[];
    const {root,cache}=agyPaths(this.options);
    try {
      const canonicalRoot=await realpath(root),path=await realpath(cache);
      const leaf=await lstat(cache);
      if(!contains(canonicalRoot,path)||leaf.isSymbolicLink()||!leaf.isFile())throw new Error('unsafe-path');
      const data=await this.file(path,canonicalRoot,this.limits.maxBytes,{bytes:0});
      const result=await this.parseCache(data.bytes,diagnostics);
      if(await realpath(cache)!==path)throw Error('metadata-unstable');
      return result;
    } catch(error) {
      const code=error instanceof Error?error.message:'';
      this.diagnostic(diagnostics,['unsafe-path','input-limit','metadata-unstable','malformed-record'].includes(code)?code as CodexDiagnostic['code']:(error as NodeJS.ErrnoException).code==='ENOENT'?'metadata-unavailable':'read-failed');
      return {sessions:[],ambiguous:new Set()};
    }
  }
  private async parseCache(data:Buffer,diagnostics:CodexDiagnostic[]):Promise<{sessions:readonly AgySession[];ambiguous:ReadonlySet<string>}> {
    let parsed:unknown;
      try {parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}
      catch {throw new Error('malformed-record');}
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('malformed-record');
      const entries=Object.entries(parsed);if(entries.length>this.limits.maxEntries)throw Error('input-limit');
      const sessions=new Map<string,AgySession>(),ambiguous=new Set<string>();
      for(const [recorded,id] of entries.slice(0,this.limits.maxEntries)) {
        // Unicode mode matches lone surrogate code units but preserves valid astral pairs.
        if(!isAbsolute(recorded)||/[\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(recorded)||Buffer.byteLength(recorded)>4096||typeof id!=='string'||!agyNativeId.test(id)){this.diagnostic(diagnostics,'malformed-record');continue;}
        let workspace=resolve(recorded);try{workspace=await realpath(workspace);}catch{this.diagnostic(diagnostics,'workspace-unavailable');}
        if(sessions.has(id.toLowerCase())&&sessions.get(id.toLowerCase())!.workspace!==workspace){ambiguous.add(id.toLowerCase());this.diagnostic(diagnostics,'ambiguous-rollout');continue;}
        const key=createHash('sha256').update(JSON.stringify([id,workspace])).digest('hex');
        sessions.set(id.toLowerCase(),{id:`agy:${key}`,nativeId:id,agent:'agy',workspace,title:`Last cached conversation ${id} (metadata only)`,updatedAt:'',messages:[],metadataOnly:true});
      }
      return {sessions:[...sessions.values()].filter(session=>!ambiguous.has(session.nativeId.toLowerCase())).sort((a,b)=>a.id.localeCompare(b.id)),ambiguous:new Set([...ambiguous].map(id=>id.toLowerCase()))};
  }
  private generation:Catalog|undefined;
  private async file(path:string,root:string,limit:number,budget:{bytes:number}):Promise<{bytes:Buffer;signature:string}> {
    const leaf=await lstat(path);
    if(!leaf.isFile()||leaf.isSymbolicLink()||await realpath(path)!==path||!contains(root,path))throw Error('unsafe-path');
    const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    try {
      const before=await handle.stat();
      if(identity(before)!==identity(leaf)||!before.isFile()||before.size>limit||before.size>this.limits.maxScanBytes-budget.bytes)throw Error('input-limit');
      budget.bytes+=before.size;
      const bytes=Buffer.alloc(before.size);let offset=0;
      while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)throw Error('metadata-unstable');offset+=read.bytesRead;}
      if(identity(before)!==identity(await handle.stat())||identity(before)!==identity(await lstat(path))||await realpath(path)!==path)throw Error('metadata-unstable');
      return {bytes,signature:identity(before)};
    }finally{await handle.close();}
  }
  private async noSidecars(path:string,catalog:Catalog):Promise<void> {
    const directory=dirname(path),name=basename(path);
    let info;
    try {info=await lstat(directory);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const signature=info?identity(info):'absent',previous=catalog.directories.get(directory);
    if(previous&&previous.signature!==signature)throw Error('metadata-unstable');
    if(!info){catalog.directories.set(directory,{signature,names:new Set()});return;}
    if(!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==directory)throw Error('unsafe-path');
    let names=previous?.names;
    if(!names) {
      names=new Set<string>();
      let entries=0;
      for await(const entry of await opendir(directory)) {
        if(++entries>this.limits.maxFiles)throw Error('input-limit');
        const match=/^(.*\.db)-(?:wal|shm|journal|mj.*)$/.exec(entry.name);if(match)names.add(match[1]!);
      }
      if(identity(await lstat(directory))!==signature)throw Error('metadata-unstable');
      catalog.directories.set(directory,{signature,names});
    }
    if(names.has(name))throw Error('unsupported-mode');
  }
  private async physical(root:string,catalog:Catalog):Promise<string> {
    const path=join(root,'conversation_summaries.db');
    await this.noSidecars(path,catalog);
    if(await realpath(path)!==path)throw Error('unsafe-path');
    const info=await lstat(path),parent=await lstat(root);
    if(!info.isFile()||info.isSymbolicLink()||info.size<100||info.size>this.limits.maxDatabaseBytes)throw Error('input-limit');
    return JSON.stringify([identity(info),identity(parent)]);
  }
  private failure(diagnostics:CodexDiagnostic[],error:unknown):void {
    const code=error instanceof Error?error.message:'';
    this.diagnostic(diagnostics,['unsafe-path','input-limit','metadata-unstable','malformed-record','unsupported-shape','unsupported-mode','partial-record','invalid-ordinal','invalid-boundary','ambiguous-rollout'].includes(code)?code as CodexDiagnostic['code']:'read-failed');
  }
  private async catalog():Promise<Catalog> {
    const diagnostics:CodexDiagnostic[]=[],root=await realpath(agyPaths(this.options).root).catch(()=>agyPaths(this.options).root);
    const catalog:Catalog={root,records:new Map(),diagnostics,signature:'',cacheSignature:'',budget:{bytes:0},directories:new Map()};
    const path=join(root,'conversation_summaries.db');
    let present;
    try {present=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){this.failure(diagnostics,error);return catalog;}}
    if(!present){for(const session of (await this.cached()).sessions)catalog.records.set(session.nativeId,{session});return catalog;}
    let db:DatabaseSync|undefined;
    try {
      const signature=await this.physical(root,catalog);
      db=new DatabaseSync(pathToFileURL(path).href+'?mode=ro&immutable=1',{readOnly:true});
      const schema=db.prepare("SELECT type,sql FROM sqlite_schema WHERE name='conversation_summaries'").get();
      const columns=db.prepare('PRAGMA table_info(conversation_summaries)').all();
      if(schema?.type!=='table'||typeof schema.sql!=='string'||/VIRTUAL/i.test(schema.sql)||
         !selectedColumns.every(name=>columns.some(c=>c.name===name))||
         !columns.some(c=>c.name==='conversation_id'&&c.pk===1))throw Error('unsupported-shape');
      const rows=db.prepare(`SELECT ${selectedColumns.join(',')} FROM conversation_summaries ORDER BY last_modified_time DESC,conversation_id LIMIT ?`).all(this.limits.maxEntries+1);
      if(rows.length>this.limits.maxEntries)throw Error('input-limit');
      db.close();db=undefined;
      if(signature!==await this.physical(root,catalog))throw Error('metadata-unstable');
      catalog.signature=signature;
      let cached:readonly AgySession[]=[],cacheAmbiguous:ReadonlySet<string>=new Set();
      try {
        const cache=await this.file(join(root,'cache','last_conversations.json'),root,this.limits.maxBytes,catalog.budget);
        const data=await this.parseCache(cache.bytes,diagnostics);
        catalog.cacheSignature=cache.signature;
        cached=data.sessions;cacheAmbiguous=data.ambiguous;
      }catch(error){
        if((error as NodeJS.ErrnoException).code==='ENOENT')this.diagnostic(diagnostics,'metadata-unavailable');
        else this.failure(diagnostics,error);
      }
      const known=new Set<string>(),ambiguous=new Set<string>();
      for(const row of rows) {
        const id=row.conversation_id;
        if(typeof id==='string'&&agyNativeId.test(id)) {if(known.has(id.toLowerCase()))ambiguous.add(id.toLowerCase());known.add(id.toLowerCase());}
      }
      for(const row of rows)try {
        const id=row.conversation_id;
        if(typeof id!=='string'||!agyNativeId.test(id)||id!==id.toLowerCase()||ambiguous.has(id)||cacheAmbiguous.has(id))throw Error('ambiguous-rollout');
        // Native subagent conversations belong to their parent and are skipped silently, whatever their state. Their
        // IDs stay in `known`, so a cache entry naming one is not listed as a metadata-only session either.
        if(typeof row.parent_conversation_id==='string'&&agyNativeId.test(row.parent_conversation_id)&&
           Number.isSafeInteger(row.nesting_depth)&&Number(row.nesting_depth)>=1&&(row.agent_name==null||typeof row.agent_name==='string'))continue;
        if(row.status!=='CASCADE_RUN_STATUS_IDLE'||row.not_fully_idle!==0||row.killed!==0||
           row.source!==''||row.parent_conversation_id!==''||row.agent_name!==''||
           row.nesting_depth!==0||row.battle_id!==''||row.winning_conversation_id!==''||
           row.app_data_dir!=='antigravity-cli'||!Number.isSafeInteger(row.step_count)||
           Number(row.step_count)<2||Number(row.step_count)>this.limits.maxItems)throw Error('unsupported-mode');
        if(typeof row.workspace_uris!=='string'||Buffer.byteLength(row.workspace_uris)>8192)throw Error('malformed-record');
        const uris:unknown=row.workspace_uris===''?[]:JSON.parse(row.workspace_uris);
        if(!Array.isArray(uris)||uris.length>1)throw Error('ambiguous-rollout');
        const fallback=cached.find(s=>s.nativeId.toLowerCase()===id);
        let recorded:string;
        if(uris.length) {
          if(typeof uris[0]!=='string')throw Error('malformed-record');
          const url=new URL(uris[0]);if(url.protocol!=='file:'||url.host||url.search||url.hash)throw Error('unsafe-path');
          recorded=fileURLToPath(url);
        }else {if(!fallback)throw Error('workspace-unavailable');recorded=fallback.workspace;}
        if(!isAbsolute(recorded)||/[\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(recorded)||Buffer.byteLength(recorded)>4096)throw Error('unsafe-path');
        const workspace=await realpath(recorded).catch(()=>resolve(recorded));
        if(fallback&&fallback.workspace!==workspace)throw Error('ambiguous-rollout');
        const date=typeof row.last_modified_time==='string'?Date.parse(row.last_modified_time):NaN;
        if(!Number.isFinite(date))throw Error('malformed-record');
        const key=createHash('sha256').update(JSON.stringify([id,workspace])).digest('hex');
        const session:AgySession={
          id:`agy:${key}`,nativeId:id,agent:'agy',workspace,title:`Antigravity conversation ${id}`,
          updatedAt:new Date(date).toISOString(),messages:[],metadataOnly:false,
        };
        catalog.records.set(id,{session,stepCount:Number(row.step_count)});
      }catch(error){this.failure(diagnostics,error);}
      for(const session of cached)if(!known.has(session.nativeId.toLowerCase()))catalog.records.set(session.nativeId,{session});
      if(signature!==await this.physical(root,catalog))throw Error('metadata-unstable');
      if(catalog.cacheSignature&&identity(await lstat(join(root,'cache','last_conversations.json')))!==catalog.cacheSignature)throw Error('metadata-unstable');
    }catch(error){catalog.records.clear();this.failure(diagnostics,error);}
    finally{db?.close();}
    return catalog;
  }
  async discover():Promise<readonly AgySession[]> {
    this.generation=await this.catalog();return [...this.generation.records.values()].map(r=>r.session).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
  }
  async readHistory(id:string):Promise<readonly HistoryItem[]> {return (await this.readHistoryDetailed(id)).items;}
  async readHistoryDetailed(id:string):Promise<AgyHistory> {return this.selected(await this.catalog(),id);}
  async readCatalogHistoryDetailed(id:string):Promise<AgyHistory> {return this.selected(this.generation??await this.catalog(),id);}
  async readCatalogTitleItems(id:string):Promise<readonly HistoryItem[]> {
    const catalog=this.generation;
    if(!catalog)return [];
    const history=await this.selected({...catalog,budget:{bytes:0}},id,true);
    return history.complete ? history.items : [];
  }
  private async selected(catalog:Catalog,id:string,forTitle=false):Promise<AgyHistory> {
    const diagnostics:CodexDiagnostic[]=[],record=catalog.records.get(id);
    if(!record||record.session.metadataOnly)return {items:[],complete:false,retained:false,diagnostics:[{code:'unsupported-shape',source:'history'}]};
    try {
      if(await this.physical(catalog.root,catalog)!==catalog.signature)throw Error('metadata-unstable');
      await this.noSidecars(join(catalog.root,'conversations',id+'.db'),catalog);
      const path=join(catalog.root,'brain',id,'.system_generated','logs','transcript.jsonl');
      const limit=forTitle ? Math.min(512*1024,this.limits.maxFileBytes) : this.limits.maxFileBytes;
      const before=await this.file(path,catalog.root,limit,catalog.budget);
      const parsed=parseAgyHistory(new TextDecoder('utf-8',{fatal:true}).decode(before.bytes),id,record.stepCount!,this.limits);
      const after=await this.file(path,catalog.root,limit,catalog.budget);
      if(before.signature!==after.signature||!before.bytes.equals(after.bytes)||await this.physical(catalog.root,catalog)!==catalog.signature)throw Error('metadata-unstable');
      await this.noSidecars(join(catalog.root,'conversations',id+'.db'),catalog);
      if(catalog.cacheSignature&&identity(await lstat(join(catalog.root,'cache','last_conversations.json')))!==catalog.cacheSignature)throw Error('metadata-unstable');
      if(parsed.lagging&&!forTitle)this.diagnostic(diagnostics,'step-count-lag','history');
      return {
        items:parsed.items,complete:true,retained:false,diagnostics,excludedSteps:parsed.excludedSteps,
        incarnation:createHash('sha256').update(JSON.stringify([catalog.root,id,JSON.parse(before.signature).slice(0,2)])).digest('hex'),
        snapshotIdentity:createHash('sha256').update(JSON.stringify([catalog.signature,catalog.cacheSignature,before.signature])).digest('hex'),
      };
    }catch(error){if(!forTitle)this.failure(diagnostics,error);return {items:[],complete:false,retained:false,diagnostics};}
  }
}
interface CatalogRecord {session:AgySession;stepCount?:number}
interface Catalog {root:string;records:Map<string,CatalogRecord>;diagnostics:CodexDiagnostic[];signature:string;cacheSignature:string;budget:{bytes:number};directories:Map<string,{signature:string;names:Set<string>}>}
// conversation_summaries columns the reader needs; other columns are ignored.
const selectedColumns=['conversation_id','step_count','last_modified_time','workspace_uris','status','source','agent_name','parent_conversation_id','nesting_depth','battle_id','winning_conversation_id','not_fully_idle','killed','app_data_dir'];
