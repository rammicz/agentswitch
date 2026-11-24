import {constants} from 'node:fs';
import {lstat,open,opendir,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import type {Session,HistoryItem} from '../domain.js';
import type {SessionAdapter} from './index.js';
import {contains,type CodexDiagnostic,type DiagnosticCode} from './codex-io.js';

export const grokNativeId=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface GrokSession extends Session {readonly schemaProfile:'conversation-v1'}
export interface GrokHistory {items:readonly HistoryItem[];complete:boolean;retained:false;diagnostics:readonly CodexDiagnostic[];incarnation?:string}
const defaults={maxFiles:10000,maxFileBytes:32*1024*1024,maxLineBytes:1024*1024,maxMetadataBytes:1024*1024,maxScanBytes:256*1024*1024,maxItems:100000,maxDiagnostics:100};
export interface GrokAdapterOptions {root?:string;home?:string;env?:NodeJS.ProcessEnv;limits?:Partial<typeof defaults>;onDiagnostic?:(value:CodexDiagnostic)=>void}
export function grokPaths(options:GrokAdapterOptions={}):{root:string} {
 const env=options.env??process.env;
 return {root:resolve(options.root??(env.GROK_HOME||join(options.home??homedir(),'.grok')))};
}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const signature=(s:{dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number})=>JSON.stringify([s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs]);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const safePath=(v:unknown):v is string=>typeof v==='string'&&isAbsolute(v)&&Buffer.byteLength(v)<=4096&&!/[\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(v);
const timestamp=(v:unknown):v is string=>typeof v==='string'&&v.length<=64&&Number.isFinite(Date.parse(v));
interface RecordLocation {session:GrokSession;directory:string;metadata:string;incarnation:string}
interface Scan {root:string;records:Map<string,RecordLocation>;diagnostics:CodexDiagnostic[];bytes:number;entries:number;complete:boolean}
/** Direct, bounded and read-only projection of the pinned public ConversationItem v1 store. */
export class GrokSessionAdapter implements SessionAdapter {
 readonly id='grok' as const;
 private readonly limits;
 private generation:Scan|undefined;
 constructor(private readonly options:GrokAdapterOptions={}) {
  this.limits={...defaults,...options.limits};
  for(const [key,value]of Object.entries(this.limits))if(!Number.isSafeInteger(value)||value<1||value>defaults[key as keyof typeof defaults])throw new RangeError(`Invalid Grok limit: ${key}`);
 }
 private add(scan:Scan,code:DiagnosticCode,source:CodexDiagnostic['source']='history',line?:number):void {
  if(scan.diagnostics.length>=this.limits.maxDiagnostics)return;
  const value:CodexDiagnostic={code,source,...(line===undefined?{}:{line})};scan.diagnostics.push(value);this.options.onDiagnostic?.(value);
 }
 private async read(path:string,scan:Scan,limit:number):Promise<{bytes:Buffer}> {
  if((await lstat(path)).isSymbolicLink())throw Error('unsafe-path');
  const canonical=await realpath(path);if(canonical!==path||!contains(scan.root,canonical))throw Error('unsafe-path');
  const handle=await open(canonical,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try {
   const before=await handle.stat();if(!before.isFile()||before.size>limit||before.size>this.limits.maxScanBytes-scan.bytes)throw Error('input-limit');
   const bytes=Buffer.alloc(before.size);let offset=0;
   while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)throw Error('metadata-unstable');offset+=read.bytesRead;scan.bytes+=read.bytesRead;}
   if(signature(before)!==signature(await handle.stat())||signature(before)!==signature(await lstat(path))||await realpath(path)!==canonical)throw Error('metadata-unstable');
   return {bytes};
  }finally{await handle.close();}
 }
 private failure(scan:Scan,error:unknown,source:CodexDiagnostic['source']):void {
  const code=error instanceof Error?error.message:'';
  this.add(scan,['unsafe-path','input-limit','metadata-unstable','unsupported-shape','malformed-record'].includes(code)?code as DiagnosticCode:'read-failed',source);
 }
 private async scan():Promise<Scan> {
  const scan:Scan={root:grokPaths(this.options).root,records:new Map(),diagnostics:[],bytes:0,entries:0,complete:true};const ambiguous=new Set<string>(),seen=new Set<string>();
  try {
   scan.root=await realpath(scan.root);
   const sessions=join(scan.root,'sessions');if((await lstat(sessions)).isSymbolicLink())throw Error('unsafe-path');
   // Buckets are opaque (including hashed long cwd names); only summary.info.cwd is authoritative.
   const buckets=await opendir(sessions);
   for await(const bucket of buckets) {
    if(++scan.entries>this.limits.maxFiles){scan.complete=false;this.add(scan,'input-limit','root');break;}
    if(bucket.isSymbolicLink()){this.add(scan,'unsafe-path','root');continue;}if(!bucket.isDirectory())continue;
    const bucketPath=join(sessions,bucket.name);const children=await opendir(bucketPath);
    for await(const child of children) {
     if(++scan.entries>this.limits.maxFiles){scan.complete=false;this.add(scan,'input-limit','root');break;}
     if(child.isSymbolicLink()){this.add(scan,'unsafe-path','metadata');continue;}if(!child.isDirectory())continue;
     if(!grokNativeId.test(child.name)){this.add(scan,'unsupported-shape','metadata');continue;}
     // Reject duplicates even when one copy is hidden or unsupported.
     if(seen.has(child.name)){ambiguous.add(child.name);scan.records.delete(child.name);this.add(scan,'ambiguous-rollout','metadata');continue;}seen.add(child.name);
     const directory=join(bucketPath,child.name);
     try {
      const data=await this.read(join(directory,'summary.json'),scan,this.limits.maxMetadataBytes);const metadata=data.bytes.toString('utf8');
      const row:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data.bytes));
      if(!object(row)||!object(row.info)||row.info.id!==child.name||!safePath(row.info.cwd)||!timestamp(row.created_at)||!timestamp(row.updated_at))throw Error('malformed-record');
      // Native subagent sessions belong to their parent and are skipped like Claude's, whatever their format version.
      if(typeof row.session_kind==='string'&&/^subagent(?:_|$)/.test(row.session_kind))continue;
      if(row.chat_format_version!==1)throw Error('unsupported-shape');
      if(row.hidden===true)continue;
      if(row.session_kind!=null||row.cwd_generation||row.previous_cwd!=null||row.pending_cwd_switch_reminder!=null||row.source_workspace_dir!=null||row.prompt_display_cwd!=null)throw Error('unsupported-shape');
      if(row.hidden!=null&&row.hidden!==false)throw Error('malformed-record');
      const title=row.generated_title??row.session_summary;
      if(typeof title!=='string'||Buffer.byteLength(title)>8192||!timestamp(row.last_active_at??row.updated_at))throw Error('malformed-record');
      let workspace=resolve(row.info.cwd);try{workspace=await realpath(workspace);}catch{this.add(scan,'workspace-unavailable','workspace');}
      const key=hash(JSON.stringify([scan.root,child.name,row.created_at]));
      const session:GrokSession={id:`grok:${key}`,agent:'grok',nativeId:child.name,title,workspace,updatedAt:new Date(row.last_active_at as string??row.updated_at).toISOString(),messages:[],schemaProfile:'conversation-v1'};
      scan.records.set(child.name,{session,directory,metadata,incarnation:key});
     }catch(error){this.failure(scan,error,'metadata');}
    }
    if(scan.entries>this.limits.maxFiles)break;
   }
  }catch(error){scan.complete=false;this.failure(scan,error,'root');}
  for(const id of ambiguous)scan.records.delete(id);
  return scan;
 }
 async discover():Promise<readonly GrokSession[]> {this.generation=await this.scan();return [...this.generation.records.values()].map(v=>v.session).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));}
 async readHistory(id:string):Promise<readonly HistoryItem[]> {return (await this.readHistoryDetailed(id)).items;}
 async readCatalogHistoryDetailed(id:string):Promise<GrokHistory>{return this.readSelected(this.generation??await this.scan(),id);}
 async readHistoryDetailed(id:string):Promise<GrokHistory> {return this.readSelected(await this.scan(),id);}
 private async readSelected(generation:Scan,id:string):Promise<GrokHistory> {
  // Each read has its own byte budget and diagnostics; only the discovered records are shared.
  const scan:Scan={...generation,diagnostics:[],bytes:0};
  const record=scan.records.get(id);const items:HistoryItem[]=[];
  // Sibling diagnostics do not make this selected public snapshot incomplete.
  let complete=!!record&&scan.complete;
  if(record)try {
   const data=await this.read(join(record.directory,'chat_history.jsonl'),scan,this.limits.maxFileBytes);
   const text=new TextDecoder('utf-8',{fatal:true}).decode(data.bytes);const lines=text.split('\n');
   // An unfinished final line may still be written, so even complete JSON there is never projected.
   if(lines.pop()!==''){this.add(scan,'partial-record');complete=false;}
   let seenHuman=false,seenMarker=false;
   for(const [ordinal,line]of lines.entries()) {
    if(ordinal>=this.limits.maxItems){complete=false;this.add(scan,'input-limit');break;}
    if(Buffer.byteLength(line)>this.limits.maxLineBytes){complete=false;this.add(scan,'input-limit','history',ordinal+1);continue;}
    try {
     const row:unknown=JSON.parse(line);if(!object(row))throw Error('unsupported-shape');
     let role:HistoryItem['role'],value:string;
     // Backend tool calls are raw tool records with no public text, like the omitted tool arguments.
     if(row.type==='system'||row.type==='reasoning'||row.type==='backend_tool_call')continue;
     if(row.type==='user') {
      if(row.synthetic_reason!==undefined&&row.synthetic_reason!=='human') {
       const known=['primary','compaction_meta','system_reminder','length_continue','project_instructions','auto_continue','auto_recovery','interjection','agent_message','parent_agent_message','task_completed','subagent_completed','notification_drain','goal_summary','goal_classifier_nudge','scheduler_fired','stop_hook_feedback','working_directory_switch','parent_human_message','session_prefix','direct_bash','goal_setup','unknown'];
       if(typeof row.synthetic_reason!=='string'||!known.includes(row.synthetic_reason))throw Error('unsupported-shape');continue;
      }
      if(row.prompt_index!==undefined&&(!Number.isSafeInteger(row.prompt_index)||Number(row.prompt_index)<0))throw Error('unsupported-shape');
      const marked=row.prompt_index!==undefined;
      // Native v1's first unmarked human is a runtime preamble; after markers,
      // unmarked human followups can be runtime bash/permission injections.
      if(!marked&&(!seenHuman||seenMarker)){seenHuman=true;continue;}seenHuman=true;seenMarker ||= marked;
      if(!Array.isArray(row.content)||!row.content.every(part=>object(part)&&part.type==='text'&&typeof part.text==='string'))throw Error('unsupported-shape');
      role='user';value=row.content.map(part=>(part as {text:string}).text).join('\n');
     }else if(row.type==='assistant'&&typeof row.content==='string'){role='assistant';value=row.content;}
     else if(row.type==='tool_result'&&typeof row.content==='string'&&typeof row.tool_call_id==='string'&&(row.images===undefined||Array.isArray(row.images))){role='tool';value=row.content;}
     else throw Error('unsupported-shape');
     if(value)items.push({id:hash(JSON.stringify([record.incarnation,ordinal,role,value])),role,text:value,status:'complete'});
    }catch{complete=false;this.add(scan,'unsupported-shape','history',ordinal+1);}
   }
   const after=await this.read(join(record.directory,'summary.json'),scan,this.limits.maxMetadataBytes);if(after.bytes.toString('utf8')!==record.metadata)throw Error('metadata-unstable');
  }catch(error){complete=false;this.failure(scan,error,'history');}
  else this.add(scan,'selected-rollout-unavailable');
  return {items,complete,retained:false,diagnostics:scan.diagnostics,...(record?{incarnation:record.incarnation}:{})};
 }
}
