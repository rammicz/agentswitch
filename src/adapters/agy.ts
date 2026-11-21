import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Session, HistoryItem } from '../domain.js';
import type { SessionAdapter } from './index.js';
import type { CodexDiagnostic } from './codex-io.js';
import { contains } from './codex-io.js';

export const agyNativeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface AgySession extends Session { readonly metadataOnly:true }
export interface AgyHistory { items:readonly HistoryItem[]; complete:false; retained:false; diagnostics:readonly CodexDiagnostic[] }
export interface AgyAdapterOptions {
  root?:string; home?:string; env?:NodeJS.ProcessEnv;
  limits?:Partial<{maxBytes:number;maxEntries:number;maxDiagnostics:number}>;
  onDiagnostic?:(diagnostic:CodexDiagnostic)=>void;
}
/** App-specific root override; native GEMINI_HOME behavior is not inferred. */
export function agyPaths(options:AgyAdapterOptions={}):{root:string;cache:string} {
  const env=options.env??process.env;
  const root=resolve(options.root??(env.AGENTSWITCH_AGY_ROOT?.trim()||join(options.home??homedir(),'.gemini','antigravity-cli')));
  return {root,cache:join(root,'cache','last_conversations.json')};
}
const defaults={maxBytes:1024*1024,maxEntries:1000,maxDiagnostics:100};
const identity=(info:{dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number}):string=>JSON.stringify([info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs]);

/** Sparse local last-ID metadata only. Never opens ACP, private DBs, logs or credentials. */
export class AgySessionAdapter implements SessionAdapter {
  readonly id='agy' as const;
  private readonly limits;
  constructor(private readonly options:AgyAdapterOptions={}) {
    this.limits={...defaults,...options.limits};
    for(const [name,value] of Object.entries(this.limits))if(!Number.isSafeInteger(value)||value<1||value>defaults[name as keyof typeof defaults])throw new RangeError(`Invalid agy limit: ${name}`);
  }
  private diagnostic(list:CodexDiagnostic[],code:CodexDiagnostic['code']):void {
    if(list.length>=this.limits.maxDiagnostics)return;
    const value:CodexDiagnostic={code,source:'metadata'};list.push(value);this.options.onDiagnostic?.(value);
  }
  async discover():Promise<readonly AgySession[]> {
    const diagnostics:CodexDiagnostic[]=[];
    const {root,cache}=agyPaths(this.options);
    try {
      const canonicalRoot=await realpath(root),path=await realpath(cache);
      if(!contains(canonicalRoot,path)||(await lstat(cache)).isSymbolicLink())throw new Error('unsafe-path');
      const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let data:Buffer;
      try {
        const before=await handle.stat();
        if(!before.isFile()||before.size>this.limits.maxBytes)throw new Error('input-limit');
        data=Buffer.alloc(before.size);let offset=0;
        while(offset<data.length){const read=await handle.read(data,offset,data.length-offset,offset);if(!read.bytesRead)throw new Error('metadata-unstable');offset+=read.bytesRead;}
        if(identity(before)!==identity(await handle.stat())||identity(before)!==identity(await lstat(path))||await realpath(cache)!==path)throw new Error('metadata-unstable');
      } finally {await handle.close();}
      let parsed:unknown;
      try {parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}
      catch {throw new Error('malformed-record');}
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('malformed-record');
      const entries=Object.entries(parsed);if(entries.length>this.limits.maxEntries)this.diagnostic(diagnostics,'input-limit');
      const sessions=new Map<string,AgySession>(),ambiguous=new Set<string>();
      for(const [recorded,id] of entries.slice(0,this.limits.maxEntries)) {
        // Unicode mode matches lone surrogate code units but preserves valid astral pairs.
        if(!isAbsolute(recorded)||/[\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(recorded)||Buffer.byteLength(recorded)>4096||typeof id!=='string'||!agyNativeId.test(id)){this.diagnostic(diagnostics,'malformed-record');continue;}
        let workspace=resolve(recorded);try{workspace=await realpath(workspace);}catch{this.diagnostic(diagnostics,'workspace-unavailable');}
        if(sessions.has(id)&&sessions.get(id)!.workspace!==workspace){ambiguous.add(id);this.diagnostic(diagnostics,'ambiguous-rollout');continue;}
        const key=createHash('sha256').update(JSON.stringify([id,workspace])).digest('hex');
        sessions.set(id,{id:`agy:${key}`,nativeId:id,agent:'agy',workspace,title:`Last cached conversation ${id} (metadata only)`,updatedAt:'',messages:[],metadataOnly:true});
      }
      return [...sessions.values()].filter(session=>!ambiguous.has(session.nativeId)).sort((a,b)=>a.id.localeCompare(b.id));
    } catch(error) {
      const code=error instanceof Error?error.message:'';
      this.diagnostic(diagnostics,['unsafe-path','input-limit','metadata-unstable','malformed-record'].includes(code)?code as CodexDiagnostic['code']:(error as NodeJS.ErrnoException).code==='ENOENT'?'metadata-unavailable':'read-failed');
      return [];
    }
  }
  async readHistory(_id:string):Promise<readonly HistoryItem[]> {return [];}
  async readHistoryDetailed(_id:string):Promise<AgyHistory> {
    // An empty cache projection is not an empty native transcript.
    return {items:[],complete:false,retained:false,diagnostics:[{code:'unsupported-shape',source:'history'}]};
  }
  readCatalogHistoryDetailed(id:string):Promise<AgyHistory> {return this.readHistoryDetailed(id);}
}
