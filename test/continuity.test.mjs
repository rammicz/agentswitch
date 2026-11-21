import test from 'node:test';
import assert from 'node:assert/strict';
import { observeContext, chooseContinuation, contextKey, retainedContext, matchingEcho } from '../dist/continuity.js';
import { createHash } from 'node:crypto';

const ref=(agent='codex',nativeId='A',root='root-a',incarnation='file-a')=>({agent,nativeId,id:agent+':'+nativeId,root,incarnation,workspace:'/workspace',sourceKey:root+nativeId});
const item=(id,text=id)=>({id,role:'user',status:'complete',text});
test('A→B→A chooses actual A and exact noncontiguous missing activities',()=>{
 const a=observeContext({ref:ref(),items:[item('a1'),item('a2')],retained:true},[],[],[]);
 const b=observeContext({ref:ref('claude','B'),items:[item('b1'),item('b2'),item('b3')],retained:true},[a.context],[],a.items,a.lineage);
 const candidate={...a.context,lineageId:b.lineage.id,epoch:b.lineage.epoch,coveredIds:[a.items[0].id,b.items.at(-1).id],ownIds:a.items.map(x=>x.id)};
 const plan=chooseContinuation(b,[candidate],new Map([[contextKey(candidate.ref),{...candidate,retained:true}]]),'codex','/workspace');
 assert.equal(plan.target.nativeId,'A');
 assert.deepEqual(plan.items.map(x=>x.id),b.items.filter(x=>!new Set([...candidate.ownIds,...candidate.coveredIds]).has(x.id)).map(x=>x.id));
});
test('rollback removes invalidated activities and refuses context still retaining them',()=>{
 const initial=observeContext({ref:ref(),items:[item('a1'),item('a2')],retained:true},[],[],[]);
 const reverted=observeContext({ref:ref(),items:[item('a1')],retained:true},[initial.context],[],initial.items,initial.lineage);
 assert.deepEqual(reverted.items.map(x=>x.text),['a1']);
 assert.notEqual(reverted.lineage.epoch,initial.lineage.epoch);
 assert.equal(chooseContinuation(reverted,[initial.context],new Map(), 'codex','/workspace').target,null);
 const stale=observeContext({ref:ref(),items:[item('a1'),item('a2')],retained:true},[initial.context],[],initial.items,reverted.lineage);
 assert.deepEqual(stale.items.map(x=>x.text),['a1']);assert.equal(stale.context.retained,false);
});
test('explicit active-source boundary permanently excludes unavailable application ancestry',()=>{
 const a=observeContext({ref:ref(),items:[item('a1')],retained:true},[],[],[]);
 const b=observeContext({ref:ref('claude','B'),items:[item('b1')],retained:false},[a.context],[],a.items,a.lineage);
 const fresh=observeContext({ref:ref('claude','B'),items:[item('b1')],retained:false},[b.context],[],b.items,b.lineage,true,true);
 assert.deepEqual(fresh.items.map(x=>x.text),['b1']);assert.ok(fresh.lineage.excludedIds.includes(a.items[0].id));
 const stale=observeContext({ref:ref(),items:[item('a1')],retained:true},[a.context],[],b.items,fresh.lineage);assert.deepEqual(stale.items.map(x=>x.text),['b1']);assert.equal(stale.context.retained,false);
});
test('root, replacement and independent native growth never inherit retained compatibility',()=>{
 const a=observeContext({ref:ref(),items:[item('a1')],retained:true},[],[],[]);
 for(const changed of [ref('codex','A','other-root'),ref('codex','A','root-a','replacement')])assert.notEqual(contextKey(changed),contextKey(a.context.ref));
 assert.equal(retainedContext(a.context,{ref:ref(),items:[item('a1'),item('a2','independent continuation')],retained:true}),false);
 assert.equal(retainedContext(a.context,{ref:ref(),items:[item('a1','revised')],retained:true}),false);
});
test('only unique immutable launched nonce-bearing prompt echoes alias; arbitrary JSON and equal text remain activities',()=>{
 const a=observeContext({ref:ref(),items:[item('a1')],retained:true},[],[],[]);
 const prompt=JSON.stringify({history:a.items,currentRequest:'B current',omissions:{archive:'immutable-nonce'}}),payloadHash=createHash('sha256').update(prompt).digest('hex');
 const known={id:'attempt',target:'claude',targetNativeId:null,prompt,payloadHash,includedItemIds:a.lineage.ids,archive:{id:'immutable-nonce'},launch:'observed',retired:false,deleted:false,deleting:false,continuity:{lineage:a.lineage,targetRoot:'root-a',requestId:'b-current'}};
 const echo=item('echo',prompt),bref=ref('claude','B');assert.equal(matchingEcho(echo,bref,[known]).id,'attempt');
 assert.equal(matchingEcho(echo,bref,[known,known]),undefined);assert.equal(matchingEcho(echo,ref('claude','B','other'),[known]),undefined);
 assert.equal(matchingEcho(item('echo','{"history":[]}'),bref,[known]),undefined);
 const b=observeContext({ref:bref,items:[echo,item('repeat1','same'),item('repeat2','same')],retained:true},[a.context],[known],a.items,a.lineage);
 assert.deepEqual(b.items.map(x=>x.text),['a1','B current','same','same']);assert.equal(new Set(b.items.map(x=>x.id)).size,4);
 assert.equal(b.context.retained,false);assert.ok(!b.context.ownIds.includes(a.items[0].id));assert.ok(!b.context.ownIds.includes('b-current'));assert.deepEqual(b.context.coveredIds,[]);
});
test('raw native public item IDs are retained only as nonreversible metadata hashes',()=>{
 const observed=observeContext({ref:ref(),items:[item('SECRET_NATIVE_ITEM_ID','public')],retained:true},[],[],[]);
 assert.equal(JSON.stringify(observed.context).includes('SECRET_NATIVE_ITEM_ID'),false);
});
