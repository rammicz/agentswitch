/** Provider-native identifiers are meaningful only within their adapter. */
export type AgentId = 'codex' | 'claude' | 'opencode';
export type Scope = 'folder' | 'global';

export interface Session {
  id: string;
  agent: AgentId;
  nativeId: string;
  title: string;
  workspace: string;
  updatedAt: string;
  /** Searchable, public conversation text; never hidden reasoning. */
  messages: readonly HistoryItem[];
}

export interface HistoryItem {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  status: 'complete' | 'interrupted' | 'failed';
  /** Non-sensitive origin attribution for canonical cross-provider activity. */
  origin?: { agent: AgentId; context: string };
}

export interface SessionQuery {
  text: string;
  agent: AgentId | 'all';
  scope: Scope;
  workspace: string;
}

/** Future durable transfer record. Pending is not proof of consumption. */
export interface Handoff {
  id: string;
  sourceSessionId: string;
  targetAgent: AgentId;
  selectedItemIds: readonly string[];
  omittedItemIds: readonly string[];
  state: 'prepared' | 'pending' | 'accepted' | 'uncertain' | 'failed';
}
