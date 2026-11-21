import type { AgentId, HistoryItem, Session } from '../domain.js';

/** Implementations read native history without changing the source files. */
export interface SessionAdapter {
  readonly id: AgentId;
  discover(): Promise<readonly Session[]>;
  readHistory(nativeId: string): Promise<readonly HistoryItem[]>;
}

/** Catalog only: no provider currently claims a working adapter. */
export const agentCatalog = [
  { id: 'codex', label: 'Codex', status: 'planned' },
  { id: 'claude', label: 'Claude Code', status: 'planned' },
] as const;
