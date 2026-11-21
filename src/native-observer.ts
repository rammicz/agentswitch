/** Silent launch-local Codex hook. No output, raw history reads, decisions or setting writes. */
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeIncarnation } from './continuity.js';
import { digest, TransferJournal } from './transfer-journal.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const shellQuote=(value:string):string=>`'${value.replaceAll("'","'\\''")}'`;
/** Stable for the installed package, never includes per-attempt metadata in native trust identity. */
export function observerCommand():string {
  return `${shellQuote(process.execPath)} --disable-warning=ExperimentalWarning ${shellQuote(fileURLToPath(new URL('./native-observer.js',import.meta.url)))}`;
}
function within(root:string,path:string):boolean {const part=relative(root,path);return part!==''&&!isAbsolute(part)&&part!=='..'&&!part.startsWith('../');}
export async function observeNativeHook(input:unknown,locator:string):Promise<void> {
  if(locator.length>16384)throw Error();
  const config=JSON.parse(locator) as Record<string,unknown>;
  if(Object.keys(config).sort().join(',')!=='attempt,journal,root,rootPath,token'||!Object.values(config).every(value=>typeof value==='string'&&value.length<8192)||!uuid.test(config.attempt as string)||!uuid.test(config.token as string)||!/^[a-f0-9]{64}$/.test(config.root as string)||!isAbsolute(config.journal as string)||!isAbsolute(config.rootPath as string))throw Error();
  if(!input||typeof input!=='object')throw Error();
  const event=input as Record<string,unknown>;
  if(!['UserPromptSubmit','Stop'].includes(String(event.hook_event_name))||event.agent_id!=null||event.agent_type!=null||typeof event.session_id!=='string'||!uuid.test(event.session_id)||typeof event.turn_id!=='string'||!event.turn_id||event.turn_id.length>256||typeof event.cwd!=='string'||typeof event.transcript_path!=='string'||!isAbsolute(event.transcript_path))throw Error();
  const root=await realpath(config.rootPath as string),transcript=await realpath(event.transcript_path),workspace=await realpath(event.cwd);
  if(![join(root,'sessions'),join(root,'archived_sessions')].some(path=>within(path,transcript))||!new RegExp(`-${event.session_id}(?:_[a-f0-9-]{36})?\\.jsonl$`,'i').test(basename(transcript)))throw Error();
  const info=await stat(transcript);if(!info.isFile())throw Error();
  const journal=await TransferJournal.open(config.journal as string);
  try {
    const record=journal.get(config.attempt as string);
    const target={agent:'codex' as const,id:`codex:${event.session_id}`,nativeId:event.session_id,root:config.root as string,incarnation:nativeIncarnation(info),workspace,sourceKey:digest(JSON.stringify(['observer',config.root,event.session_id]))};
    // Resume uses the exact catalog identity; a fresh context gains its actual native identity here.
    if(record.continuity?.targetRef) {target.id=record.continuity.targetRef.id;target.sourceKey=record.continuity.targetRef.sourceKey;}
    journal.observe(record.id,config.token as string,{name:event.hook_event_name as 'UserPromptSubmit'|'Stop',target,turnId:event.turn_id,...(event.hook_event_name==='UserPromptSubmit'?{promptHash:typeof event.prompt==='string'?digest(event.prompt):''}:{})});
  } finally {journal.close();}
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]) {
  // Bound both bytes and elapsed time. Missing/disabled/untrusted hooks leave delivery unknown.
  const timer=setTimeout(()=>process.exit(0),4000);
  try {
    let bytes=0;const chunks:Buffer[]=[];
    for await(const chunk of process.stdin) {const value=Buffer.from(chunk as Uint8Array);bytes+=value.length;if(bytes>65536)throw Error();chunks.push(value);}
    await observeNativeHook(JSON.parse(Buffer.concat(chunks).toString('utf8')),process.env.AGENTSWITCH_OBSERVER??'');
  } catch { /* Diagnostics must never reveal the submitted prompt, native history or locator. */ }
  finally {clearTimeout(timer);}
}
