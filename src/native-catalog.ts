import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexSessionAdapter, ClaudeSessionAdapter, OpenCodeSessionAdapter, openCodePaths, AgySessionAdapter, agyPaths, GrokSessionAdapter, grokPaths } from './adapters/index.js';
import type { CodexDiagnostic, CodexHistory, CodexSession, ClaudeSession, OpenCodeSession, AgySession, GrokSession } from './adapters/index.js';
import { setTimeout } from 'node:timers/promises';
import type { AgentId, HistoryItem, Session, SessionQuery } from './domain.js';
import type { SessionHit, SessionSource } from './tui/contracts.js';
import { matchSession, type SearchIndex } from './search-index.js';
import type { RuntimeSource } from './runtime.js';
import { digest } from './transfer-journal.js';
import type { ContextRef } from './continuity.js';

const agents: readonly AgentId[] = ['codex','claude','opencode','agy','grok'];
const canonical = async (path: string): Promise<string> => realpath(resolve(path)).catch(()=>resolve(path));
const harmless = new Set(['workspace-unavailable','metadata-unavailable','metadata-schema','metadata-unstable','untested-producer']);
export interface NativeSnapshot { session: CodexSession | ClaudeSession | OpenCodeSession | AgySession | GrokSession; history: CodexHistory; fingerprint: string; runtime: RuntimeSource; sourceKey: string; context:ContextRef; retained:boolean; metadataOnly?:boolean; projectionNotice?:string }

/** Captures native quality before committing generations; healthy siblings remain searchable. */
export class NativeCatalog {
  private readonly diagnostics: Record<AgentId, CodexDiagnostic[]> = {codex:[],claude:[],opencode:[],agy:[],grok:[]};
  private readonly warnings: Record<AgentId,string> = {codex:'',claude:'',opencode:'',agy:'',grok:''};
  private readonly adapters: { codex: CodexSessionAdapter; claude: ClaudeSessionAdapter; opencode:OpenCodeSessionAdapter; agy:AgySessionAdapter; grok:GrokSessionAdapter };
  private readonly staged = new Map<AgentId, Map<string,Session>>();
  private readonly discoveries = new Map<AgentId, Promise<readonly Session[]>>();
  private constructor(private readonly roots: Record<AgentId,string>, private readonly rootKeys: Record<AgentId,string>, sqliteRoot: string,opencodeDb:string) {
    const onDiagnostic=(agent:AgentId)=>(diagnostic:CodexDiagnostic)=>{if(this.diagnostics[agent].length<100)this.diagnostics[agent].push(diagnostic);};
    this.adapters={grok:new GrokSessionAdapter({root:roots.grok,onDiagnostic:onDiagnostic('grok')}),agy:new AgySessionAdapter({root:roots.agy,onDiagnostic:onDiagnostic('agy')}),codex:new CodexSessionAdapter({root:roots.codex,sqliteRoot,onDiagnostic:onDiagnostic('codex')}),claude:new ClaudeSessionAdapter({root:roots.claude,onDiagnostic:onDiagnostic('claude')}),opencode:new OpenCodeSessionAdapter({dbPath:opencodeDb,onDiagnostic:onDiagnostic('opencode')})};
  }
  static async create(env:NodeJS.ProcessEnv=process.env):Promise<NativeCatalog> {
    const opencode=openCodePaths({env});
    const roots={grok:await canonical(grokPaths({env}).root),agy:await canonical(agyPaths({env}).root),opencode:await canonical(opencode.root),codex:await canonical(env.CODEX_HOME?.trim()||join(homedir(),'.codex')),claude:await canonical(env.CLAUDE_CONFIG_DIR?.trim()||join(homedir(),'.claude'))};
    const rootInfo=await stat(roots.opencode).catch(()=>undefined);
    const sqlite=await canonical(env.CODEX_SQLITE_HOME?.trim()||roots.codex);
    return new NativeCatalog(roots,{grok:roots.grok,agy:roots.agy,codex:JSON.stringify([roots.codex,sqlite]),claude:roots.claude,opencode:JSON.stringify([roots.opencode,rootInfo?`${rootInfo.dev}:${rootInfo.ino}`:'missing',await canonical(opencode.dbPath)])},sqlite,opencode.dbPath);
  }
  sources() { return agents.map(agent=>({sourceId:digest(this.rootKeys[agent]),adapter:{id:agent,discover:async()=>[...(this.staged.get(agent)?.values()??[])],readHistory:async(nativeId:string)=>this.staged.get(agent)?.get(nativeId)?.messages??[]}})); }
  rootKey(agent:AgentId):string {return digest(this.rootKeys[agent]);}
  rootPath(agent:AgentId):string {return this.roots[agent];}
  notices():readonly string[] {return agents.map(agent=>this.warnings[agent]).filter(Boolean);}
  private report(agent:AgentId, extra=''):void {
    const codes=[...new Set(this.diagnostics[agent].map(diagnostic=>diagnostic.code))];
    this.warnings[agent]=codes.length||extra ? `${agent}: ${extra||'source warnings'}${codes.length?' ('+codes.slice(0,5).join(', ')+(codes.length>5?', …':'')+')':''}` : '';
  }
  /** List with metadata first and read one relevant transcript at a time for text searches. */
  async search(query:SessionQuery, signal:AbortSignal, lifetime:AbortSignal, publish:(hits:readonly SessionHit[])=>void,
    searchCache:()=>Promise<SearchIndex|undefined>):Promise<readonly SessionHit[]> {
    const text=query.text.trim();
    if(text) await setTimeout(120,undefined,{signal});
    const workspace=query.scope==='folder'?(await canonical(query.workspace)).normalize('NFC'):undefined;
    const selected=agents.filter(agent=>query.agent==='all'||query.agent===agent);
    const hits=new Map<string,SessionHit>();
    const ordered=()=>[...hits.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
    let lastPublish=0;
    const update=()=>{
      if(signal.aborted)return;
      lastPublish=Date.now();
      publish(ordered());
    };
    await Promise.all(selected.map(async agent=>{
      signal.throwIfAborted();
      let discovery=this.discoveries.get(agent);
      if(!discovery){
        const adapter=this.adapters[agent];
        discovery=(adapter instanceof CodexSessionAdapter||adapter instanceof ClaudeSessionAdapter
          ?adapter.discover(lifetime):adapter.discover()).catch(()=>{
          this.warnings[agent]=`${agent}: history discovery unavailable`;
          return [];
        });
        this.discoveries.set(agent,discovery);
      }
      const sessions=(await discovery).filter(session=>workspace===undefined||session.workspace.normalize('NFC')===workspace);
      signal.throwIfAborted();
      for(const session of sessions){
        const hit=matchSession(session,text);
        if(hit)hits.set(session.id,hit);
      }
      if(hits.size)update();
      if(text){
        for(const session of sessions){
          signal.throwIfAborted();
          if('metadataOnly' in session&&session.metadataOnly)continue;
          const history=await this.adapters[agent].readCatalogHistoryDetailed(session.nativeId).catch(()=>undefined);
          signal.throwIfAborted();
          const readable=history?.complete ? {...session,messages:history.items} : undefined;
          const hit=readable ? matchSession(readable,text)
            : await searchCache().then(cache=>cache?.remembered(session,text)).catch(()=>undefined);
          signal.throwIfAborted();
          if(hit){
            if(readable) await searchCache().then(cache=>cache?.remember(readable)).catch(()=>undefined);
            signal.throwIfAborted();
            hits.set(session.id,hit);
            if(Date.now()-lastPublish>=200)update();
          }
        }
      }
      if(!this.warnings[agent].endsWith('history discovery unavailable'))this.report(agent);
      if(hits.size)update();
    }));
    return ordered();
  }
  async refresh(index:SearchIndex):Promise<void> {
    for(const agent of agents) {
      this.diagnostics[agent]=[];
      try {
        const managed=agent==='codex'?[join(this.roots.codex,'sessions'),join(this.roots.codex,'archived_sessions')]:[join(this.roots.claude,'projects')];
        if(agent!=='grok'&&agent!=='opencode'&&agent!=='agy'&&!(await Promise.all(managed.map(async path=>(await stat(path).catch(()=>undefined))?.isDirectory()))).some(Boolean)) {
          this.warnings[agent]=`${agent}: history root unavailable; previous search data retained`;continue;
        }
        const sessions=await this.adapters[agent].discover();
        // agy's metadata file is its entire source, rather than optional enrichment.
        const isDegraded=()=>this.diagnostics[agent].some(diagnostic=>agent==='grok'||agent==='opencode'||agent==='agy'||!harmless.has(diagnostic.code));
        let degraded=isDegraded();
        const healthy:Session[]=[];
        for(const session of sessions) {
          if(agent==='agy'&&'metadataOnly' in session&&session.metadataOnly){healthy.push(session);continue;}
          const history=await this.adapters[agent].readCatalogHistoryDetailed(session.nativeId);
          if(!history.complete) {degraded=true;continue;}
          let title=session.title;
          if(agent==='agy') {
            const line=history.items.find(item=>item.role==='user')?.text.split(/\r?\n/).find(line=>line.trim());
            if(line)title=Array.from(line.trim()).slice(0,100).join('');
          }
          healthy.push({...session,title,messages:history.items});
        }
        degraded ||= isDegraded();
        this.staged.set(agent,new Map(healthy.map(session=>[session.nativeId,session])));
        await index.refresh(agent,{preserveMissing:degraded});
        this.report(agent,agent==='agy'?'public text from quiescent local histories. Sparse cached IDs remain metadata only':degraded?'degraded source; earlier entries retained, healthy sessions refreshed':'');
      } catch {
        this.warnings[agent]=`${agent}: refresh failed; previous search data retained`;
      }
    }
  }
  async snapshot(source:SessionSource, signal?:AbortSignal):Promise<NativeSnapshot> {
    signal?.throwIfAborted();this.diagnostics[source.agent]=[];
    const session=(await this.adapters[source.agent].discover()).find(session=>session.nativeId===source.nativeId&&session.id===source.id);
    if(!session) {this.report(source.agent,'selected history unavailable; cached entry may be stale');throw new Error('Selected source is unavailable. Refresh or restore its native history.');}
    const history:CodexHistory=await this.adapters[source.agent].readHistoryDetailed(source.nativeId);
    this.report(source.agent,source.agent==='agy'&&'metadataOnly' in session&&session.metadataOnly?'metadata only. Native open available, outgoing public history unavailable':history.complete?'':'selected public history incomplete. Transfer blocked');signal?.throwIfAborted();
    const producer='producerVersion' in session?session.producerVersion:undefined;
    const compatible=session.agent==='grok'?true:session.agent==='agy'?true:session.agent==='opencode'?producer==='1.19.6':session.agent==='codex' ? producer==='0.171.0' : !producer||producer==='2.1.330';
    const runtime:RuntimeSource={agent:session.agent,id:session.id,nativeId:session.nativeId,workspace:session.workspace,nativeResume:compatible?'compatible':'unknown'};
    const sourceKey=digest(JSON.stringify([source.agent,this.rootKeys[source.agent],source.nativeId]));
    const context:ContextRef={...runtime,root:this.rootKey(source.agent),incarnation:history.incarnation??'unknown',sourceKey};
    return {session,history,runtime,fingerprint:digest(JSON.stringify([runtime,history.items,history.complete,context.incarnation,history.retained,history.itemTurns,'snapshotIdentity' in history?history.snapshotIdentity:null,'excludedSteps' in history?history.excludedSteps:[]])),sourceKey,context,retained:compatible&&history.retained===true,...(source.agent==='agy'?{metadataOnly:'metadataOnly' in session&&session.metadataOnly===true,projectionNotice:`Antigravity public-text projection excludes internal metadata, settings, thinking and raw tool data. Excluded native tool step indexes: ${'excludedSteps' in history&&Array.isArray(history.excludedSteps)&&history.excludedSteps.length?history.excludedSteps.join(', '):'none'}. Archive completeness describes this public-text projection.`}:{})};
  }
}
