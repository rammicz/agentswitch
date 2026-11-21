import { createHash, randomUUID } from 'node:crypto';
import type { AgentId, HistoryItem } from './domain.js';
import type { SessionSource } from './tui/contracts.js';

const hash=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ContextRef extends SessionSource { root:string; incarnation:string; workspace:string; sourceKey:string }
export interface NativeActivity { id:string; revision:string; ids:readonly string[]; turn?:string }
export interface NativeItemTurn { id:string; threadId:string; turnId:string }
/** Metadata only. Public text lives in native files or explicitly approved archives. */
export interface NativeContext {
  ref:ContextRef; lineageId:string; epoch:number; nativeItems:readonly NativeActivity[];
  ownIds:readonly string[]; coveredIds:readonly string[]; retained:boolean;
  acceptedAttempts?:readonly string[];
}
export interface Lineage { id:string; epoch:number; revision:number; ids:readonly string[]; excludedIds?:readonly string[] }
export interface ContinuityIntent {
  lineage:Lineage; baseRevision:number; sourceContext:NativeContext;
  targetRoot:string; targetRef:ContextRef|null; requestId:string;
}
export interface ObservedContext { context:NativeContext; lineage:Lineage; items:readonly HistoryItem[]; baseRevision:number; reason?:string }
export interface ContextSnapshot { ref:ContextRef; items:readonly HistoryItem[]; retained:boolean; itemTurns?:readonly NativeItemTurn[] }
export interface EchoAttempt {
  id:string; target:AgentId; targetNativeId:string|null; payloadHash:string; prompt?:string;
  includedItemIds:readonly string[]; launch:string; retired:boolean; deleted:boolean; deleting:boolean;
  continuity?:ContinuityIntent;
  archive?:{id:string}|null;
  state?:string;
  observation?:{target:ContextRef};
  receiptTurnId?:string;
}
export const contextKey=(ref:ContextRef):string=>hash([ref.agent,ref.root,ref.nativeId,ref.incarnation]);
export const activityRevision=(item:HistoryItem):string=>hash([item.role,item.status,item.text]);
const turnIdentity=(item:NativeItemTurn):string=>hash([item.threadId,item.turnId]);
export function canonicalActivity(ref:ContextRef,item:HistoryItem):HistoryItem {
  const key=contextKey(ref);return {...item,id:hash([key,item.id,activityRevision(item)]),origin:{agent:ref.agent,context:key}};
}
export function retainedPrefix(context:NativeContext,snapshot:ContextSnapshot):boolean {
  const turns=new Map(snapshot.itemTurns?.map(item=>[hash(item.id),turnIdentity(item)]));
  return context.retained&&snapshot.retained&&contextKey(context.ref)===contextKey(snapshot.ref)
    &&context.nativeItems.length<=snapshot.items.length
    &&context.nativeItems.every((entry,index)=>snapshot.items[index]&&hash(snapshot.items[index]!.id)===entry.id&&activityRevision(snapshot.items[index]!)===entry.revision&&(!entry.turn||turns.get(entry.id)===entry.turn));
}
export const retainedContext=(context:NativeContext,snapshot:ContextSnapshot):boolean=>context.nativeItems.length===snapshot.items.length&&retainedPrefix(context,snapshot);
/** Only an exact echo of a unique, actually launched immutable attempt is an alias.
 * Its archive nonce is inside the hashed prompt. JSON-looking native text has no authority. */
export function matchingEcho(item:HistoryItem,ref:ContextRef,attempts:readonly EchoAttempt[]):EchoAttempt|undefined {
  if(item.role!=='user')return;
  const promptHash=hashPrompt(item.text);
  const matches=attempts.filter(attempt=>attempt.continuity&&attempt.prompt===item.text&&attempt.payloadHash===promptHash
    &&attempt.archive&&item.text.includes(attempt.archive.id)
    &&attempt.target===ref.agent&&attempt.continuity.targetRoot===ref.root&&(!attempt.targetNativeId||attempt.targetNativeId===ref.nativeId)
    &&['possible','observed'].includes(attempt.launch)&&!attempt.deleted&&!attempt.deleting);
  return matches.length===1?matches[0]:undefined;
}
const hashPrompt=(value:string):string=>createHash('sha256').update(value).digest('hex');
export const nativeIncarnation=(info:{dev:number;ino:number;birthtimeMs:number}):string=>hash([info.dev,info.ino,info.birthtimeMs]);

/** Certify only the single completed main turn belonging to an accepted receipt.
 * An unchanged prefix alone never authorizes unrelated appended native activity. */
export function reconcileAcceptedTurn(context:NativeContext,snapshot:ContextSnapshot,attempt:EchoAttempt):NativeContext|null {
  if(attempt.state!=='accepted'||attempt.retired||attempt.deleted||attempt.deleting||!attempt.receiptTurnId||!attempt.observation||contextKey(attempt.observation.target)!==contextKey(snapshot.ref)||attempt.targetNativeId!==snapshot.ref.nativeId||!retainedPrefix(context,snapshot))return null;
  const suffix=snapshot.items.slice(context.nativeItems.length),echo=suffix[0];
  if(suffix.length<2||!echo||matchingEcho(echo,snapshot.ref,[attempt])?.id!==attempt.id||echo.status!=='complete'||suffix.at(-1)?.role!=='assistant'||suffix.slice(1).some(item=>item.role==='user'||item.status==='interrupted'||item.role==='assistant'&&item.status!=='complete'))return null;
  const turns=new Map(snapshot.itemTurns?.map(item=>[item.id,item]));
  const correlated=(item:HistoryItem):boolean=>{const turn=turns.get(item.id);return turn?.threadId===snapshot.ref.nativeId&&turn.turnId===attempt.receiptTurnId;};
  if(!suffix.every(correlated)||snapshot.items.slice(0,context.nativeItems.length).some(correlated)||snapshot.items.filter(item=>item.role==='user'&&item.text===attempt.prompt).length!==1)return null;
  const own=suffix.slice(1).map(item=>canonicalActivity(snapshot.ref,item));
  return {...context,nativeItems:[...context.nativeItems,...suffix.map((item,index)=>({id:hash(item.id),revision:activityRevision(item),ids:index===0?[...attempt.includedItemIds,attempt.continuity!.requestId]:[own[index-1]!.id],turn:turnIdentity(turns.get(item.id)!)}))],ownIds:[...new Set([...context.ownIds,...own.map(item=>item.id)])]};
}

/** Project the selected active native branch before budgeting. No persistence or acceptance. */
export function observeContext(snapshot:ContextSnapshot,contexts:readonly NativeContext[],attempts:readonly EchoAttempt[],retainedItems:readonly HistoryItem[],knownLineage?:Lineage,explicitFresh=false,sourceOnly=false):ObservedContext {
  const key=contextKey(snapshot.ref),previous=contexts.find(context=>contextKey(context.ref)===key);
  const echoes=snapshot.items.map(item=>matchingEcho(item,snapshot.ref,attempts));
  const linked=echoes.find(Boolean)?.continuity?.lineage;
  const lineage=knownLineage??linked??{id:previous?.lineageId??randomUUID(),epoch:previous?.epoch??0,revision:0,ids:[]};
  if(previous&&previous.lineageId!==lineage.id)throw new Error('Native context belongs to a different lineage. Choose a fresh context.');
  if(echoes.some(attempt=>attempt?.continuity?.lineage.id&&attempt.continuity.lineage.id!==lineage.id))throw new Error('Conflicting native transfer lineage. Choose a fresh context.');
  const byId=new Map(retainedItems.map(item=>[item.id,item]));
  const turns=new Map(snapshot.itemTurns?.map(item=>[item.id,item]));
  const native=(item:HistoryItem,ids:readonly string[]):NativeActivity=>({id:hash(item.id),revision:activityRevision(item),ids,...(turns.get(item.id)?.turnId&&turns.get(item.id)?.threadId?{turn:turnIdentity(turns.get(item.id)!)}:{})});
  const ownIds:string[]=[],activeIds:string[]=[],nativeItems:NativeActivity[]=[];
  let unacceptedEcho=false;
  for(let index=0;index<snapshot.items.length;index++) {
    const item=snapshot.items[index]!,echo=echoes[index];
    // An explicitly deleted immutable payload must not return as a new native activity.
    if(item.role==='user'&&attempts.some(attempt=>(attempt.deleted||attempt.deleting)&&attempt.payloadHash===hashPrompt(item.text))) {
      nativeItems.push(native(item,[]));continue;
    }
    if(echo?.continuity) {
      const ids=[...echo.includedItemIds,echo.continuity.requestId];
      // The approved prompt is already retained by this attempt, never parse an arbitrary envelope.
      const parsed=JSON.parse(echo.prompt!) as {currentRequest:string};
      byId.set(echo.continuity.requestId,{id:echo.continuity.requestId,role:'user',text:parsed.currentRequest,status:'complete',origin:{agent:snapshot.ref.agent,context:key}});
      nativeItems.push(native(item,ids));activeIds.push(...ids);
      // Recorded input is not accepted input. Aliases connect provenance only;
      // coverage still comes exclusively from the atomic successful receipt.
      if(echo.state!=='accepted'||!echo.observation||contextKey(echo.observation.target)!==key)unacceptedEcho=true;
    } else {
      const canonical=canonicalActivity(snapshot.ref,item),id=canonical.id;
      byId.set(id,canonical);
      nativeItems.push(native(item,[id]));ownIds.push(id);
      activeIds.push(id);
    }
  }
  const active=new Map(nativeItems.map(item=>[item.id,item]));
  const invalid=new Set(previous?.nativeItems.flatMap(item=>active.get(item.id)?.revision===item.revision&&(!item.turn||active.get(item.id)?.turn===item.turn)?[]:item.ids)??[]);
  const changed=invalid.size>0;
  const cutoff=lineage.ids.findIndex(id=>invalid.has(id));
  // Rollback invalidates the causal suffix as well as the removed native items.
  const nativeIds=new Set(activeIds);
  const excluded=new Set([...(lineage.excludedIds??[]),...(cutoff<0?[]:lineage.ids.slice(cutoff)),...invalid,...(sourceOnly?lineage.ids.filter(id=>!nativeIds.has(id)):[])]);
  const epoch=lineage.epoch+(changed||explicitFresh?1:0);
  const ids=[...new Set([...(sourceOnly?[]:lineage.ids),...activeIds])].filter(id=>!excluded.has(id));
  if(ids.some(id=>!byId.has(id)))throw new Error('Retained lineage archive is unavailable. Restore it or choose explicit fresh source recovery.');
  const containsExcluded=activeIds.some(id=>excluded.has(id));
  const context:NativeContext={ref:snapshot.ref,lineageId:lineage.id,epoch,nativeItems,ownIds:[...new Set(ownIds)],coveredIds:changed||explicitFresh?[]:previous?.coveredIds??[],retained:snapshot.retained&&!changed&&!explicitFresh&&!containsExcluded&&!unacceptedEcho,acceptedAttempts:changed||explicitFresh?[]:previous?.acceptedAttempts??[]};
  return {context,lineage:{id:lineage.id,epoch,revision:lineage.revision+1,ids,excludedIds:[...excluded]},baseRevision:lineage.revision,items:ids.map(id=>byId.get(id)!),...(changed||containsExcluded?{reason:'The selected native branch contains removed or changed activity; rebuild in a new context.'}:explicitFresh?{reason:'Explicit fresh boundary: earlier native contexts are excluded from reuse.'}:{})};
}

/** Eligible set minus exact retained/accepted IDs, never a high-water ordinal. */
export function chooseContinuation(observed:ObservedContext,contexts:readonly NativeContext[],validated:ReadonlyMap<string,NativeContext>,target:AgentId,workspace:string):{target:ContextRef|null;items:readonly HistoryItem[];reason:string} {
  const eligible=new Set(observed.lineage.ids);
  const candidates=contexts.filter(context=>context.lineageId===observed.lineage.id&&context.epoch===observed.lineage.epoch&&context.ref.agent===target&&context.ref.workspace===workspace)
    .map(context=>validated.get(contextKey(context.ref))).filter((context):context is NativeContext=>Boolean(context?.retained))
    .filter(context=>[...context.ownIds,...context.coveredIds].every(id=>eligible.has(id)))
    .sort((a,b)=>new Set([...b.ownIds,...b.coveredIds]).size-new Set([...a.ownIds,...a.coveredIds]).size||contextKey(a.ref).localeCompare(contextKey(b.ref)));
  const candidate=candidates[0];
  if(!candidate)return {target:null,items:observed.items,reason:observed.reason??'No compatible retained native context with verified identity and coverage; use a fresh bounded rebuild.'};
  const covered=new Set([...candidate.ownIds,...candidate.coveredIds]);
  return {target:candidate.ref,items:observed.items.filter(item=>!covered.has(item.id)),reason:'Reuse the exact earlier native context; send only missing eligible activity.'};
}
