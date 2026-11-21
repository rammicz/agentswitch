import type { AgentId, HistoryItem, Session } from '../domain.js';

/** Implementations read native history without changing the source files. */
export interface SessionAdapter {
  readonly id: AgentId;
  discover(): Promise<readonly Session[]>;
  readHistory(nativeId: string): Promise<readonly HistoryItem[]>;
}

/** Catalog tracks end-to-end provider support; a read-only Codex reader is available separately. */
export const agentCatalog = [
  { id: 'codex', label: 'Codex', status: 'planned' },
  { id: 'claude', label: 'Claude Code', status: 'planned' },
] as const;

export { CodexSessionAdapter } from './codex.js';
export type { CodexAdapterOptions, CodexDiagnostic, CodexHistory, CodexLimits, CodexSession } from './codex.js';
