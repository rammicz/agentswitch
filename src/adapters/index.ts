import type { AgentId, HistoryItem, Session } from '../domain.js';

/** Implementations read native history without changing the source files. */
export interface SessionAdapter {
  readonly id: AgentId;
  discover(): Promise<readonly Session[]>;
  readHistory(nativeId: string): Promise<readonly HistoryItem[]>;
}

/** Catalog tracks end-to-end provider support; read-only Codex and Claude readers are available separately. */
export const agentCatalog = [
  { id: 'codex', label: 'Codex', status: 'planned' },
  { id: 'claude', label: 'Claude Code', status: 'planned' },
  { id: 'opencode', label: 'OpenCode', status: 'fixture-tested' },
  { id: 'agy', label: 'Antigravity CLI', status: 'fixture-tested' },
  { id: 'grok', label: 'Grok Build', status: 'fixture-tested' },
] as const;

export { CodexSessionAdapter } from './codex.js';
export type { CodexAdapterOptions, CodexDiagnostic, CodexHistory, CodexLimits, CodexSession } from './codex.js';

export { ClaudeSessionAdapter } from './claude.js';
export type { ClaudeAdapterOptions, ClaudeDiagnostic, ClaudeHistory, ClaudeLimits, ClaudeSession } from './claude.js';

export { OpenCodeSessionAdapter, openCodePaths, testedOpenCodeProducer } from './opencode.js';
export type { OpenCodeAdapterOptions, OpenCodeSession, OpenCodeHistory } from './opencode.js';

export { GrokSessionAdapter, grokPaths } from './grok.js';
export type { GrokAdapterOptions, GrokSession, GrokHistory } from './grok.js';

export { AgySessionAdapter, agyPaths } from './agy.js';
export type { AgyAdapterOptions, AgySession, AgyHistory } from './agy.js';
