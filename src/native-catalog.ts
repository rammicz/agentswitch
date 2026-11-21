import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexSessionAdapter, ClaudeSessionAdapter, OpenCodeSessionAdapter, openCodePaths, AgySessionAdapter, agyPaths } from './adapters/index.js';
import type { CodexDiagnostic, CodexHistory, CodexSession, ClaudeSession, OpenCodeSession, AgySession } from './adapters/index.js';
import type { AgentId, HistoryItem, Session } from './domain.js';
import type { SessionSource } from './tui/contracts.js';
import { SearchIndex } from './search-index.js';
import type { RuntimeSource } from './runtime.js';
import { digest } from './transfer-journal.js';
import type { ContextRef } from './continuity.js';

const agents: readonly AgentId[] = ['codex','claude','opencode','agy'];
const canonical = async (path: string): Promise<string> => realpath(resolve(path)).catch(()=>resolve(path));
const harmless = new Set(['workspace-unavailable','metadata-unavailable','metadata-schema','metadata-unstable','untested-producer']);
export interface NativeSnapshot { session: CodexSession | ClaudeSession | OpenCodeSession | AgySession; history: CodexHistory; fingerprint: string; runtime: RuntimeSource; sourceKey: string; context:ContextRef; retained:boolean }

/** Captures native quality before committing generations; healthy siblings remain searchable. */
export class NativeCatalog {
  private readonly diagnostics: Record<AgentId, CodexDiagnostic[]> = {codex:[],claude:[],opencode:[],agy:[]};
  private readonly warnings: Record<AgentId,string> = {codex:'',claude:'',opencode:'',agy:''};
  private readonly adapters: { codex: CodexSessionAdapter; claude: ClaudeSessionAdapter; opencode:OpenCodeSessionAdapter; agy:AgySessionAdapter };
  private readonly staged = new Map<AgentId, Map<string,Session>>();
  private constructor(private readonly roots: Record<AgentId,string>, private readonly rootKeys: Record<AgentId,string>, sqliteRoot: string,opencodeDb:string) {
    const onDiagnostic=(agent:AgentId)=>(diagnostic:CodexDiagnostic)=>{if(this.diagnostics[agent].length<100)this.diagnostics[agent].push(diagnostic);};
    this.adapters={agy:new AgySessionAdapter({root:roots.agy,onDiagnostic:onDiagnostic('agy')}),codex:new CodexSessionAdapter({root:roots.codex,sqliteRoot,onDiagnostic:onDiagnostic('codex')}),claude:new ClaudeSessionAdapter({root:roots.claude,onDiagnostic:onDiagnostic('claude')}),opencode:new OpenCodeSessionAdapter({dbPath:opencodeDb,onDiagnostic:onDiagnostic('opencode')})};
  }
  static async create(env:NodeJS.ProcessEnv=process.env):Promise<NativeCatalog> {
    const opencode=openCodePaths({env});
    const roots={agy:await canonical(agyPaths({env}).root),opencode:await canonical(opencode.root),codex:await canonical(env.CODEX_HOME?.trim()||join(homedir(),'.codex')),claude:await canonical(env.CLAUDE_CONFIG_DIR?.trim()||join(homedir(),'.claude'))};
    const rootInfo=await stat(roots.opencode).catch(()=>undefined);
    const sqlite=await canonical(env.CODEX_SQLITE_HOME?.trim()||roots.codex);
    return new NativeCatalog(roots,{agy:roots.agy,codex:JSON.stringify([roots.codex,sqlite]),claude:roots.claude,opencode:JSON.stringify([roots.opencode,rootInfo?`${rootInfo.dev}:${rootInfo.ino}`:'missing',await canonical(opencode.dbPath)])},sqlite,opencode.dbPath);
  }
  sources() { return agents.map(agent=>({sourceId:digest(this.rootKeys[agent]),adapter:{id:agent,discover:async()=>[...(this.staged.get(agent)?.values()??[])],readHistory:async(nativeId:string)=>this.staged.get(agent)?.get(nativeId)?.messages??[]}})); }
  rootKey(agent:AgentId):string {return digest(this.rootKeys[agent]);}
  rootPath(agent:AgentId):string {return this.roots[agent];}
  notices():readonly string[] {return agents.map(agent=>this.warnings[agent]).filter(Boolean);}
  private report(agent:AgentId, extra=''):void {
    const codes=[...new Set(this.diagnostics[agent].map(diagnostic=>diagnostic.code))];
    this.warnings[agent]=codes.length||extra ? `${agent}: ${extra||'source warnings'}${codes.length?' ('+codes.slice(0,5).join(', ')+(codes.length>5?', …':'')+')':''}` : '';
  }
  async refresh(index:SearchIndex):Promise<void> {
    for(const agent of agents) {
      this.diagnostics[agent]=[];
      try {
        const managed=agent==='codex'?[join(this.roots.codex,'sessions'),join(this.roots.codex,'archived_sessions')]:[join(this.roots.claude,'projects')];
        if(agent!=='opencode'&&agent!=='agy'&&!(await Promise.all(managed.map(async path=>(await stat(path).catch(()=>undefined))?.isDirectory()))).some(Boolean)) {
          this.warnings[agent]=`${agent}: history root unavailable; previous search data retained`;continue;
        }
        const sessions=await this.adapters[agent].discover();
        // agy's metadata file is its entire source, rather than optional enrichment.
        const isDegraded=()=>this.diagnostics[agent].some(diagnostic=>agent==='opencode'||agent==='agy'||!harmless.has(diagnostic.code));
        let degraded=isDegraded();
        const healthy:Session[]=[];
        for(const session of sessions) {
          if(agent==='agy'){healthy.push(session);continue;}
          const history=await this.adapters[agent].readCatalogHistoryDetailed(session.nativeId);
          if(!history.complete) {degraded=true;continue;}
          healthy.push({...session,messages:history.items});
        }
        degraded ||= isDegraded();
        this.staged.set(agent,new Map(healthy.map(session=>[session.nativeId,session])));
        await index.refresh(agent,{preserveMissing:degraded});
        this.report(agent,agent==='agy'?'metadata only; last cached IDs, no public transcript or full inventory':degraded?'degraded source; earlier entries retained, healthy sessions refreshed':'');
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
    this.report(source.agent,source.agent==='agy'?'metadata only; native open available, outgoing public history unavailable':history.complete?'':'selected public history incomplete; transfer blocked');signal?.throwIfAborted();
    const producer='producerVersion' in session?session.producerVersion:undefined;
    const compatible=session.agent==='agy'?true:session.agent==='opencode'?producer==='1.19.6':session.agent==='codex' ? producer==='0.171.0' : !producer||producer==='2.1.330';
    const runtime:RuntimeSource={agent:session.agent,id:session.id,nativeId:session.nativeId,workspace:session.workspace,nativeResume:compatible?'compatible':'unknown'};
    const sourceKey=digest(JSON.stringify([source.agent,this.rootKeys[source.agent],source.nativeId]));
    const context:ContextRef={...runtime,root:this.rootKey(source.agent),incarnation:history.incarnation??'unknown',sourceKey};
    return {session,history,runtime,fingerprint:digest(JSON.stringify([runtime,history.items,history.complete,context.incarnation,history.retained,history.itemTurns])),sourceKey,context,retained:compatible&&history.retained===true};
  }
}
