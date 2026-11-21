import { mkdir, lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Scope, Session, HistoryItem } from './domain.js';
import { deleteArchive, protectArchive, readArchiveSnapshot, releaseArchive } from './archive.js';
import { createHandoffPlan, publishHandoffPlan, type HandoffPlan } from './handoff.js';
import { grokPaths } from './adapters/grok.js';
import { agyPaths } from './adapters/agy.js';
import { openCodePaths } from './adapters/opencode.js';
import { NativeCatalog, type NativeSnapshot } from './native-catalog.js';
import { createRuntime, RuntimeError, type LaunchPlan, type RuntimeSource } from './runtime.js';
import { SearchIndex } from './search-index.js';
import { digest, TransferJournal, type TransferIntent } from './transfer-journal.js';
import { runPicker, type SessionSource } from './tui/app.js';
import { canonicalActivity, chooseContinuation, contextKey, matchingEcho, observeContext, retainedContext, retainedPrefix, type ContextRef, type ContextSnapshot, type NativeContext, type NativeItemTurn } from './continuity.js';
import { observerCommand } from './native-observer.js';

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
  const opencode=openCodePaths({env});
  const nativePaths=await Promise.all([
    grokPaths({env}).root,agyPaths({env}).root,opencode.root,join(env.XDG_CONFIG_HOME||join(homedir(),'.config'),'opencode'),
    join(env.XDG_CACHE_HOME||join(homedir(),'.cache'),'opencode'),
    join(env.XDG_STATE_HOME||join(homedir(),'.local','state'),'opencode'),
    ...(env.OPENCODE_CONFIG_DIR?[env.OPENCODE_CONFIG_DIR]:[]),
    env.CODEX_HOME||join(homedir(),'.codex'),env.CODEX_SQLITE_HOME||env.CODEX_HOME||join(homedir(),'.codex'),env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude'),
  ].map(proposedCanonical));
  // An external DB may share an ancestor with application state. Protect its
  // exact native files/sidecars, without reserving an unrelated parent directory.
  const databases=opencode.dbPath===':memory:'?[]:[...new Set([opencode.dbPath,await proposedCanonical(opencode.dbPath)])];
  const nativeFiles=await Promise.all(databases.flatMap(path=>['','-wal','-shm','-journal'].map(suffix=>proposedCanonical(path+suffix))));
  const overlap=(left:string,right:string)=>contains(left,right)||contains(right,left);
  const check=(canonical:string):void=>{
    if(nativePaths.some(path=>overlap(path,canonical))||nativeFiles.some(path=>overlap(path,canonical))||databases.some(path=>canonical.startsWith(path+'-mj')||root.startsWith(path+'-mj')))
      throw new Error('Application state and native history roots must be separate.');
  };
  check(await proposedCanonical(root));
  await mkdir(root,{recursive:true,mode:0o700});
  const info=await lstat(root);
  if(info.isSymbolicLink()||!info.isDirectory()||(process.platform!=='win32'&&((info.mode&0o077)!==0||info.uid!==process.getuid?.()))) throw new Error('Application state must be a private owned directory, without a symbolic-link leaf.');
  const canonical=await realpath(root);check(canonical);
  return {root:canonical,cache:join(canonical,'search'),archives:join(canonical,'archives'),journal:join(canonical,'transfers')};
}

interface SourceSnapshot { runtime: RuntimeSource; items: readonly HistoryItem[]; complete: boolean; fingerprint: string; sourceKey: string; context?:ContextRef; retained?:boolean; itemTurns?:readonly NativeItemTurn[] }
interface Dispatch { launch: LaunchPlan; handoff: HandoffPlan | null; intent: TransferIntent; fingerprint: string; source: SessionSource; targetFingerprint?:string; targetSource?:SessionSource }
export interface ApplicationOptions { workspace: string; scope?: Scope; env?: NodeJS.ProcessEnv; retry?: string }
// A JSON string gives an unambiguous, lossless representation even when the wire
// contains controls or ambiguous-width Unicode. JSON.parse reconstructs the exact bytes.
const encodedPrompt=(prompt:string):string=>JSON.stringify(prompt).replace(/[\x7f-\x9f\u2028\u2029]|\p{Bidi_Control}/gu,unit=>`\\u${unit.charCodeAt(0).toString(16).padStart(4,'0')}`);
const publicIdentity=(source:SessionSource):SessionSource=>({agent:source.agent,id:source.id,nativeId:source.nativeId});
const nativeProjection=(snapshot:NativeSnapshot):ContextSnapshot=>({ref:snapshot.context,items:snapshot.history.items,retained:snapshot.retained,...(snapshot.history.itemTurns?{itemTurns:snapshot.history.itemTurns}:{})});

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
          return {runtime:{...fresh.runtime,workspace:prior.workspace},items:fresh.history.items,complete:fresh.history.complete,fingerprint:fresh.fingerprint,sourceKey:fresh.sourceKey,context:fresh.context,retained:fresh.retained,...(fresh.history.itemTurns?{itemTurns:fresh.history.itemTurns}:{})};
        }
        if(source.agent!==prior.source.agent||source.nativeId!==prior.source.nativeId) throw new Error('Recovery source identity changed.');
        return {runtime:{...prior.source,workspace:prior.workspace,nativeResume:'unknown'},items:recovered?.items??[],complete:prior.completeness==='complete',fingerprint:digest(JSON.stringify([prior.payloadHash,recovered])),sourceKey:prior.sourceKey};
      }
      const snapshot:NativeSnapshot=await catalog.snapshot(source,signal);
      return {runtime:snapshot.runtime,items:snapshot.history.items,complete:snapshot.history.complete,fingerprint:snapshot.fingerprint,sourceKey:snapshot.sourceKey,context:snapshot.context,retained:snapshot.retained,...(snapshot.history.itemTurns?{itemTurns:snapshot.history.itemTurns}:{})};
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
        if(!snapshot.complete && snapshot.runtime.agent!=='agy') throw new Error('Selected public history is incomplete. Restore the source before transferring; no partial snapshot has been certified.');
        const source=publicIdentity(snapshot.runtime);sourceKeys.set(`${source.agent}:${source.nativeId}`,snapshot.sourceKey);
        const redactions=request.redactions??[];
        if(source.agent==='agy') {
          if(prior||request.fresh||request.target!=='agy')throw new Error('Antigravity cache contains metadata only. Public history is unavailable for outgoing or fresh handoffs; open the exact native session instead.');
          if(redactions.length)throw new Error('Native open sends no history. Redactions cannot alter existing provider history.');
          const prepared=await runtime.prepare(request,request.currentRequest===undefined?{}:{currentRequest:request.currentRequest},signal);
          const intent:TransferIntent={source,sourceKey:snapshot.sourceKey,target:'agy',workspace:prepared.plan.workspace,mode:'native-resume',prompt:'',archive:null,includedItemIds:[],omittedItemIds:[],completeness:'unknown'};
          return {plan:{launch:prepared.plan,handoff:null,intent,fingerprint:snapshot.fingerprint,source},summary:{...prepared.summary,previewLines:[
            'Open the exact cached Antigravity conversation with no initial request. Type your next request in its native terminal.',
            'This cache has no transcript, title, date, producer version or global inventory. Native identity/account is revalidated by agy.',
            'Other native clients cannot be detected here. Stop concurrent writers first; native active-session and permission handling remain in agy.',
            'No public history is converted or sent. No supported native receipt transport here. This launch cannot advance accepted coverage.',
            'A missing or deleted conversation may open the native home or a fresh context. No automatic prompt is submitted.',
            'Exact current request (0 UTF-8 bytes):', 'BEGIN EXACT PROMPT JSON STRING', '""', 'END EXACT PROMPT JSON STRING',
          ]}};
        }
        // Routing fields must remain exact. Never retain a selected secret through an identifier or path.
        const routes=[source.agent,source.id,source.nativeId,request.workspace.path,await realpath(request.workspace.path),paths.root];
        if(redactions.some(value=>routes.some(route=>route.includes(value)))) throw new Error('Redaction overlaps a routing identity or storage/workspace path. Choose a different source or private storage path before transfer.');
        const contexts=journal.contexts(),attempts=journal.list();
        const ref=snapshot.context??{...source,workspace:request.workspace.path,root:catalog.rootKey(source.agent),incarnation:`recovery:${prior?.id??randomUUID()}`,sourceKey:snapshot.sourceKey};
        const existing=contexts.find(context=>contextKey(context.ref)===contextKey(ref));
        const aliases=attempts.filter(attempt=>attempt.continuity&&journal.lineage(attempt.continuity.lineage.id));
        const echo=snapshot.items.map(item=>matchingEcho(item,ref,aliases)).find(Boolean);
        const known=prior?undefined:journal.lineage(existing?.lineageId??echo?.continuity?.lineage.id??'');
        const retainedItems=new Map<string,HistoryItem>();
        let unavailableAncestry=false;
        if(known)for(const attempt of attempts.filter(attempt=>attempt.continuity?.lineage.id===known.id&&!attempt.deleted&&!attempt.deleting)) {
          if(attempt.archive) {
            try {for(const item of (await readArchiveSnapshot(attempt.archive)).items)retainedItems.set(item.id,item);}
            catch {
              if(!request.fresh)throw new Error('Required lineage archive is unavailable. Restore it, or select F and review an active-source recovery.');
              unavailableAncestry=true;
              if(attempt.prompt)for(const item of (JSON.parse(attempt.prompt) as {history:HistoryItem[]}).history)retainedItems.set(item.id,item);
            }
          }
          if(attempt.prompt&&attempt.continuity) {
            const text=attempt.archive?(JSON.parse(attempt.prompt) as {currentRequest:string}).currentRequest:attempt.prompt;
            retainedItems.set(attempt.continuity.requestId,{id:attempt.continuity.requestId,role:'user',status:'complete',text,origin:{agent:attempt.target,context:digest(JSON.stringify([attempt.continuity.targetRoot,attempt.targetNativeId]))}});
          }
        }
        const nativeSnapshots=new Map<string,NativeSnapshot>();
        const sourceIds=new Set(snapshot.items.map(item=>canonicalActivity(ref,item).id)),knownIds=new Set(known?.ids);
        // A completed native turn's new public output is metadata-only until consent.
        // Hydrate just those known own IDs from its still-matching native prefix.
        if(known)for(const context of contexts.filter(context=>context.lineageId===known.id&&context.epoch===known.epoch&&context.ref.root===catalog.rootKey(context.ref.agent)&&context.ownIds.some(id=>knownIds.has(id)&&!retainedItems.has(id)&&!sourceIds.has(id)))) {
          try {
            const native=await catalog.snapshot(context.ref,signal);nativeSnapshots.set(contextKey(context.ref),native);
            const ownIds=new Set(context.ownIds);
            if(native.history.complete&&retainedPrefix(context,nativeProjection(native)))for(const item of native.history.items.slice(0,context.nativeItems.length)) {
              const canonical=canonicalActivity(native.context,item);
              if(ownIds.has(canonical.id)&&knownIds.has(canonical.id))retainedItems.set(canonical.id,canonical);
            }
          } catch { /* Unavailable native output requires restored history or explicit source recovery. */ }
        }
        unavailableAncestry ||= Boolean(known?.ids.some(id=>!retainedItems.has(id)&&!sourceIds.has(id)));
        const sourceRecovery=Boolean(request.fresh&&unavailableAncestry);
        const observed=observeContext({ref,items:snapshot.items,retained:snapshot.retained??false,...(snapshot.itemTurns?{itemTurns:snapshot.itemTurns}:{})},prior?[]:contexts,[...aliases,...attempts.filter(attempt=>attempt.deleted||attempt.deleting)],[...retainedItems.values()],known,Boolean(prior||request.fresh||(redactions.length&&source.agent!==request.target)),sourceRecovery);
        const validated=new Map<string,NativeContext>();
        const targetSnapshots=new Map<string,NativeSnapshot>();
        if(!prior&&!request.fresh&&!redactions.length)for(const candidate of contexts.filter(context=>context.lineageId===observed.lineage.id&&context.epoch===observed.lineage.epoch&&context.ref.agent===request.target&&request.target==='codex'&&context.ref.root===catalog.rootKey(request.target))) {
          try {
            const target=nativeSnapshots.get(contextKey(candidate.ref))??await catalog.snapshot(candidate.ref,signal);
            const echoes=candidate.acceptedAttempts?.every(id=>{
              const attempt=aliases.find(attempt=>attempt.id===id);
              return attempt?.archive&&target.history.items.some(item=>matchingEcho(item,target.context,[attempt])?.id===id);
            })??true;
            if(target.history.complete&&target.retained&&echoes&&retainedContext(candidate,nativeProjection(target))) {validated.set(contextKey(candidate.ref),candidate);targetSnapshots.set(contextKey(candidate.ref),target);sourceKeys.set(`${candidate.ref.agent}:${candidate.ref.nativeId}`,target.sourceKey);}
          } catch { /* A missing/replaced/changed target receives a reviewed fresh fallback. */ }
        }
        const choice=chooseContinuation(observed,contexts,validated,request.target,await realpath(request.workspace.path));
        const ordinaryNative=!prior&&!request.fresh&&(!['opencode','grok'].includes(source.agent)||request.workspace.kind==='source')&&!observed.reason&&source.agent===request.target&&snapshot.runtime.nativeResume==='compatible';
        let target=ordinaryNative?null:choice.target;
        let fresh=!ordinaryNative&&!target;
        let reason=sourceRecovery?'Required ancestry is unavailable. Explicit fresh recovery includes only available active source and known included echoes; unavailable application ancestry is excluded.':ordinaryNative?(['opencode','grok'].includes(source.agent)?`Open the selected existing ${source.agent} session without an initial request.`:'Resume the selected source; send only the new current request.'):choice.reason;
        const makeHandoff=(items:readonly HistoryItem[])=>createHandoffPlan({directory:paths.archives,source,items,currentRequest:request.currentRequest??'Continue the task from this conversation.',redactions,completeness:'complete'});
        let handoff=ordinaryNative?null:makeHandoff(target?choice.items:observed.items);
        // Use the same redaction implementation for native current-request-only transport.
        const nativeRequest=ordinaryNative?JSON.parse(makeHandoff([]).prepared.prompt).currentRequest as string:'';
        const prepareLaunch=()=>runtime.prepare(request,{mode:fresh?'fresh':'auto',...(handoff?{handoff:handoff.prepared,observerCommand:observerCommand()}:{currentRequest:nativeRequest}),...(target?{resumeTarget:{...target,nativeResume:'compatible' as const},requireReceipt:true}:{})},signal);
        let prepared;
        try {prepared=await prepareLaunch();}catch(error) {
          if(!target||!(error instanceof RuntimeError)||!['RECEIPT_UNAVAILABLE','UNKNOWN_OWNER','ACTIVE_SESSION','INCOMPATIBLE_NATIVE','INVALID_NATIVE_ID'].includes(error.code))throw error;
          target=null;fresh=true;handoff=makeHandoff(observed.items);reason='Earlier native target or receipt capability is unavailable. Review this new bounded fresh context.';prepared=await prepareLaunch();
        }
        const prompt=handoff?.prepared.prompt??nativeRequest;
        const actualTarget=target??(ordinaryNative?snapshot.context??null:null);
        const intent:TransferIntent={source,sourceKey:snapshot.sourceKey,target:request.target,workspace:prepared.plan.workspace,mode:prepared.plan.mode,prompt,archive:handoff?.prepared.archive??null,includedItemIds:prepared.summary.includedItemIds,omittedItemIds:prepared.summary.omittedItemIds,completeness:'complete',...(prior?{retryOf:prior.id}:{}),continuity:{lineage:observed.lineage,baseRevision:observed.baseRevision,sourceContext:observed.context,targetRoot:catalog.rootKey(request.target),targetRef:actualTarget,requestId:digest(randomUUID())}};
        const targetSnapshot=target?targetSnapshots.get(contextKey(target)):undefined;
        return {plan:{launch:prepared.plan,handoff,intent,fingerprint:snapshot.fingerprint,source,...(targetSnapshot?{targetFingerprint:targetSnapshot.fingerprint,targetSource:publicIdentity(targetSnapshot.runtime)}:{})},summary:{...prepared.summary,previewLines:[
          ...(prior?[`Earlier delivery: ${prior.state}; possible duplicate context. This is a NEW fresh attempt.`]:[]),
          reason,
          ...(source.agent==='opencode'&&ordinaryNative?['OpenCode opens the exact native session without an initial request. Type the next request in its native terminal.']:[]),
          ...(target?[`Selected history source: ${source.agent} ${source.nativeId}. Actual resumed target: ${target.agent} ${target.nativeId}.`]:[]),
          ...(redactions.length?[handoff?'Selected history redactions require a new context; they cannot erase content already retained by an earlier native context.':'Redactions apply only to this new request. Earlier native context remains retained by its provider.']:[]),
          `Disclosure: ${request.target} receives ${handoff?'selected public history and the current request':source.agent==='opencode'?'no initial request; its existing native history remains in the selected session':'only the new current request; native history stays with its existing provider'} under its own account and data policies.`,
          'Hidden reasoning, credentials and native permissions do not transfer. No historical commands are replayed.',
          'Process launch/exit is not proof of prompt consumption. Delivery remains uncertain without a trusted receipt.',
          prepared.plan.observer==='codex-hooks'?'Codex launch-local submit/Stop observation is conditional on native hook enablement, trust and managed policy. Existing callbacks and permissions remain native.':'No supported native receipt transport here. This launch cannot advance accepted coverage.',
          `Archive: ${handoff?handoff.prepared.archive.directory+'/'+handoff.prepared.archive.id:'none (native resume sends only the new request)'}`,
          `Exact ${handoff?'initial user prompt':'current request'} (${Buffer.byteLength(prompt)} UTF-8 bytes):`,
          'Preview is a JSON string: decode once for the exact wire value.',
          'Unsafe controls are escaped; printable Unicode stays visible.',
          'BEGIN EXACT PROMPT JSON STRING',encodedPrompt(prompt),'END EXACT PROMPT JSON STRING',
        ]}};
      },
      continue:async dispatch=>{
        const current=await resolveSource(dispatch.source);
        if(current.fingerprint!==dispatch.fingerprint) throw new Error('Source changed after preview. Prepare and confirm the new snapshot.');
        if(dispatch.targetSource&&(await catalog.snapshot(dispatch.targetSource)).fingerprint!==dispatch.targetFingerprint)throw new Error('Earlier native target changed after preview. Prepare and confirm again.');
        const token=randomUUID();
        const record=journal.prepare({...dispatch.intent,...(dispatch.launch.observer==='codex-hooks'?{observerTokenHash:digest(token)}:{})});
        let possibleSpawn=false;let pinned=false;
        try {
          journal.begin(record.id);activeAttempt=record.id;
          if(dispatch.handoff) {await publishHandoffPlan(dispatch.handoff);await protectArchive(dispatch.handoff.prepared.archive,record.id);pinned=true;}
          const result=await runtime.launch(dispatch.launch,{beforeSpawn:()=>{possibleSpawn=true;},onSpawn:pid=>journal.spawned(record.id,pid),observer:{journal:paths.journal,attempt:record.id,token,root:catalog.rootKey(dispatch.intent.target),rootPath:catalog.rootPath(dispatch.intent.target)}});
          const accepted=journal.get(record.id);
          if(accepted.state==='accepted'&&accepted.observation)try {
            const native=await catalog.snapshot(accepted.observation.target);
            if(native.history.complete)journal.checkpointAccepted(record.id,nativeProjection(native));
          } catch { /* Acceptance is durable; an uncertified branch is never reused as earlier target. */ }
          journal.exited(record.id,result.code,result.signal);
          if(pinned) await releaseArchive(dispatch.handoff!.prepared.archive,record.id);
          const completed=journal.get(record.id);
          console.log(completed.state==='accepted'?`Transfer ${record.id}: accepted — correlated native turn ${completed.receiptTurnId} in ${completed.targetNativeId}; writer stopped.`:`Transfer ${record.id}: uncertain — process exited; prompt consumption and target session identity remain unknown.`);
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
