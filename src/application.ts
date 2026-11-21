import { mkdir, lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Scope, Session, HistoryItem } from './domain.js';
import { deleteArchive, protectArchive, readArchiveSnapshot, releaseArchive } from './archive.js';
import { createHandoffPlan, publishHandoffPlan, type HandoffPlan } from './handoff.js';
import { NativeCatalog, type NativeSnapshot } from './native-catalog.js';
import { createRuntime, type LaunchPlan, type RuntimeSource } from './runtime.js';
import { SearchIndex } from './search-index.js';
import { digest, TransferJournal, type TransferIntent } from './transfer-journal.js';
import { runPicker, type SessionSource } from './tui/app.js';

export interface ApplicationPaths { root: string; cache: string; archives: string; journal: string }
/** Resolve missing paths through their nearest existing ancestor before creating any directory. */
async function proposedCanonical(path: string): Promise<string> {
  const absolute=resolve(path);
  try {return await realpath(absolute);} catch(error) {
    if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??'')) throw error;
    const parent=dirname(absolute);if(parent===absolute)throw error;
    return resolve(await proposedCanonical(parent),relative(parent,absolute));
  }
}
const contains=(parent:string,child:string):boolean=>{const part=relative(parent,child);return part===''||(!isAbsolute(part)&&part!=='..'&&!part.startsWith('../'));};
export async function applicationPaths(env: NodeJS.ProcessEnv=process.env): Promise<ApplicationPaths> {
  const root=resolve(env.AGENTSWITCH_STATE_DIR?.trim()||join(env.XDG_STATE_HOME?.trim()||join(homedir(),'.local','state'),'agentswitch'));
  const nativePaths=await Promise.all([env.CODEX_HOME||join(homedir(),'.codex'),env.CODEX_SQLITE_HOME||env.CODEX_HOME||join(homedir(),'.codex'),env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude')].map(proposedCanonical));
  const check=(canonical:string):void=>{if(nativePaths.some(path=>contains(path,canonical)||contains(canonical,path)))throw new Error('Application state and native history roots must be separate.');};
  check(await proposedCanonical(root));
  await mkdir(root,{recursive:true,mode:0o700});
  const info=await lstat(root);
  if(info.isSymbolicLink()||!info.isDirectory()||(process.platform!=='win32'&&((info.mode&0o077)!==0||info.uid!==process.getuid?.()))) throw new Error('Application state must be a private owned directory, without a symbolic-link leaf.');
  const canonical=await realpath(root);check(canonical);
  return {root:canonical,cache:join(canonical,'search'),archives:join(canonical,'archives'),journal:join(canonical,'transfers')};
}

interface SourceSnapshot { runtime: RuntimeSource; items: readonly HistoryItem[]; complete: boolean; fingerprint: string; sourceKey: string }
interface Dispatch { launch: LaunchPlan; handoff: HandoffPlan | null; intent: TransferIntent; fingerprint: string; source: SessionSource }
export interface ApplicationOptions { workspace: string; scope?: Scope; env?: NodeJS.ProcessEnv; retry?: string }
const publicIdentity=(source:SessionSource):SessionSource=>({agent:source.agent,id:source.id,nativeId:source.nativeId});

/** Real native readers, index, reusable picker, pure consent preview, journal and runtime. */
export async function runApplication(options:ApplicationOptions):Promise<void> {
  const env=options.env??process.env;const paths=await applicationPaths(env);const journal=await TransferJournal.open(paths.journal);
  let index:SearchIndex|undefined;
  try {
    const catalog=await NativeCatalog.create(env);
    const prior=options.retry?journal.get(options.retry):undefined;
    if(prior?.deleted||prior?.deleting) throw new Error('Deleted transfer cannot be retried.');
    const recovered=prior?.archive?await readArchiveSnapshot(prior.archive):undefined;
    const resolveSource=async(source:SessionSource,signal?:AbortSignal):Promise<SourceSnapshot>=>{
      if(prior) {
        if(prior.mode==='native-resume'&&!prior.archive) {
          const fresh=await catalog.snapshot(source,signal);
          if(fresh.sourceKey!==prior.sourceKey)throw new Error('Recovery native roots differ from the original source. Restore the configured roots.');
          return {runtime:{...fresh.runtime,workspace:prior.workspace},items:fresh.history.items,complete:fresh.history.complete,fingerprint:fresh.fingerprint,sourceKey:fresh.sourceKey};
        }
        if(source.agent!==prior.source.agent||source.nativeId!==prior.source.nativeId) throw new Error('Recovery source identity changed.');
        return {runtime:{...prior.source,workspace:prior.workspace,nativeResume:'unknown'},items:recovered?.items??[],complete:prior.completeness==='complete',fingerprint:digest(JSON.stringify([prior.payloadHash,recovered])),sourceKey:prior.sourceKey};
      }
      const snapshot:NativeSnapshot=await catalog.snapshot(source,signal);
      return {runtime:snapshot.runtime,items:snapshot.history.items,complete:snapshot.history.complete,fingerprint:snapshot.fingerprint,sourceKey:snapshot.sourceKey};
    };
    let activeAttempt:string|undefined;
    const runtime=createRuntime({env,getSource:async(source,signal)=>(await resolveSource(source,signal)).runtime,
      guard:{check:source=>{
        // Native UUID namespace includes its configured roots, resolved before preparation.
        const key=sourceKeys.get(`${source.agent}:${source.nativeId}`);return key?journal.ownerState(key,activeAttempt):'unknown';
      },acquire:()=>()=>{}}});
    const sourceKeys=new Map<string,string>();
    if(!prior) {index=await SearchIndex.open({directory:paths.cache,sources:catalog.sources()});await catalog.refresh(index);}
    const recoverySession:Session|undefined=prior?{...prior.source,title:`Recovery of ${prior.id}: prior delivery ${prior.state}`,workspace:prior.workspace,updatedAt:prior.updatedAt,messages:recovered?.items??[]}:undefined;
    const initialRequest=prior?.prompt ? (prior.mode==='fresh-handoff' ? (JSON.parse(prior.prompt) as {currentRequest:string}).currentRequest : prior.prompt) : 'Continue the task from this conversation.';
    await runPicker<Dispatch>({workspace:options.workspace,scope:options.scope??'folder',compose:true,initialRequest,
      label:prior?'agentswitch / EXPLICIT FRESH RECOVERY — earlier delivery may have happened':'agentswitch / local native sessions',
      notices:()=>catalog.notices(),
      query:async(query,signal)=>{
        if(recoverySession) {const {messages,...hit}=recoverySession;return [{...hit,matches:[]}];}
        return index!.query(query,signal);
      },
      preview:async(source,signal)=>{const snapshot=await resolveSource(source,signal);return snapshot.items;},
      prepare:async(request,signal)=>{
        const snapshot=await resolveSource(request.source,signal);
        if(!snapshot.complete) throw new Error('Selected public history is incomplete. Restore the source before transferring; no partial snapshot has been certified.');
        const source=publicIdentity(snapshot.runtime);sourceKeys.set(`${source.agent}:${source.nativeId}`,snapshot.sourceKey);
        const redactions=request.redactions??[];
        // Routing fields must remain exact. Never retain a selected secret through an identifier or path.
        const routes=[source.agent,source.id,source.nativeId,request.workspace.path,await realpath(request.workspace.path),paths.root];
        if(redactions.some(value=>routes.some(route=>route.includes(value)))) throw new Error('Redaction overlaps a routing identity or storage/workspace path. Choose a different source or private storage path before transfer.');
        const fresh=Boolean(prior||request.fresh||source.agent!==request.target);
        const handoff=fresh?createHandoffPlan({directory:paths.archives,source,items:snapshot.items,currentRequest:request.currentRequest??'Continue the task from this conversation.',redactions,completeness:'complete'}):null;
        // Use the same redaction implementation for native current-request-only transport.
        const nativeRequest=fresh?'':JSON.parse(createHandoffPlan({directory:paths.archives,source,items:[],currentRequest:request.currentRequest??'Continue the task from this conversation.',redactions}).prepared.prompt).currentRequest as string;
        const prepared=await runtime.prepare(request,{mode:fresh?'fresh':'auto',...(handoff?{handoff:handoff.prepared}:{currentRequest:nativeRequest})},signal);
        const prompt=handoff?.prepared.prompt??nativeRequest;
        const intent:TransferIntent={source,sourceKey:snapshot.sourceKey,target:request.target,workspace:prepared.plan.workspace,mode:prepared.plan.mode,prompt,archive:handoff?.prepared.archive??null,includedItemIds:prepared.summary.includedItemIds,omittedItemIds:prepared.summary.omittedItemIds,completeness:'complete',...(prior?{retryOf:prior.id}:{})};
        return {plan:{launch:prepared.plan,handoff,intent,fingerprint:snapshot.fingerprint,source},summary:{...prepared.summary,previewLines:[
          ...(prior?[`Earlier delivery: ${prior.state}; possible duplicate context. This is a NEW fresh attempt.`]:[]),
          `Disclosure: ${request.target} receives ${fresh?'selected public history and the current request':'only the new current request; native history stays with its existing provider'} under its own account and data policies.`,
          'Hidden reasoning, credentials and native permissions do not transfer. No historical commands are replayed.',
          'Process launch/exit is not proof of prompt consumption. Delivery remains uncertain without a trusted receipt.',
          `Archive: ${handoff?handoff.prepared.archive.directory+'/'+handoff.prepared.archive.id:'none (native resume sends only the new request)'}`,
          `Exact ${fresh?'initial user prompt':'current request'} (${Buffer.byteLength(prompt)} UTF-8 bytes):`,prompt,
        ]}};
      },
      continue:async dispatch=>{
        const current=await resolveSource(dispatch.source);
        if(current.fingerprint!==dispatch.fingerprint) throw new Error('Source changed after preview. Prepare and confirm the new snapshot.');
        const record=journal.prepare(dispatch.intent);
        let possibleSpawn=false;let pinned=false;
        try {
          journal.begin(record.id);activeAttempt=record.id;
          if(dispatch.handoff) {await publishHandoffPlan(dispatch.handoff);await protectArchive(dispatch.handoff.prepared.archive,record.id);pinned=true;}
          const result=await runtime.launch(dispatch.launch,{beforeSpawn:()=>{possibleSpawn=true;},onSpawn:pid=>journal.spawned(record.id,pid)});
          journal.exited(record.id,result.code,result.signal);
          if(pinned) await releaseArchive(dispatch.handoff!.prepared.archive,record.id);
          console.log(`Transfer ${record.id}: uncertain — process exited; prompt consumption and target session identity remain unknown.`);
          console.log('Review: agentswitch transfers list. Nothing is replayed automatically; continuing again requires a new explicit selection and confirmation.');
          if(result.code!==0||result.signal)process.exitCode=result.code&&result.code>0?result.code:1;
        } catch(error) {
          if(possibleSpawn)journal.uncertain(record.id);
          else {journal.failedBeforeSpawn(record.id);if(pinned)await releaseArchive(dispatch.handoff!.prepared.archive,record.id);}
          // Errors from providers/storage are deliberately bounded and never echo argv/content.
          throw new Error(`Transfer ${record.id}: ${possibleSpawn?'uncertain; writer reservation retained':'failed before launch'}. Review transfers before retrying.`,{cause:error});
        }
      },
    });
  } finally {await index?.close();journal.close();}
}

export async function runTransferCommand(args:readonly string[],env:NodeJS.ProcessEnv=process.env):Promise<string|undefined> {
  const [action,id,...extra]=args;
  if(!['list','show','abort','delete','retry'].includes(action??'')||extra.length||(action==='list'?id!==undefined:!id)) throw new Error('Usage: agentswitch transfers list|show|abort|delete|retry [transfer-id]');
  const paths=await applicationPaths(env);const journal=await TransferJournal.open(paths.journal);
  try {
    if(action==='list')return JSON.stringify(journal.list().map(({prompt,...record})=>record));
    if(action==='show')return JSON.stringify(journal.get(id!));
    if(action==='retry') {journal.get(id!);return undefined;}
    if(action==='abort') {journal.abort(id!);return JSON.stringify({retired:id,note:'Historical delivery outcome and source reservation are preserved. No target was killed.'});}
    const record=journal.beginDeletion(id!);
    if(record.archive) {
      // Crashed unknown writers are refused above; a definitely pre-launch failure may still have a pin.
      await releaseArchive(record.archive,record.id).catch(error=>{if(error?.code!=='MISSING_ARCHIVE')throw error;});
      await deleteArchive(record.archive).catch(error=>{if(error?.code!=='MISSING_ARCHIVE')throw error;});
    }
    journal.delete(id!);return JSON.stringify({deleted:id,note:'Transfer content deleted; non-sensitive reservation tombstone retained.'});
  } finally {journal.close();}
}

/** Explicitly purge derived public search text independently of transfer archives. */
export async function purgeSearchCache(env:NodeJS.ProcessEnv=process.env):Promise<void> {
  const paths=await applicationPaths(env);const catalog=await NativeCatalog.create(env);
  const index=await SearchIndex.open({directory:paths.cache,sources:catalog.sources()});
  try {await index.purge();} finally {await index.close();}
}
