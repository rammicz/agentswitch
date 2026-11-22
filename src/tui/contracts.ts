import type { ReadStream, WriteStream } from 'node:tty';
import type { AgentId, HistoryItem, Scope, Session, SessionQuery } from '../domain.js';

/** Identity always includes the provider; native IDs alone need not be unique. */
export type SessionSource = Pick<Session, 'id' | 'nativeId' | 'agent'>;
export type MatchExcerpt =
  | { field: 'message'; itemId: string; role: HistoryItem['role']; text: string }
  | { field: 'title' | 'workspace' | 'nativeId'; text: string };
/** List metadata does not require loading a transcript. Matches belong to this source. */
export type SessionHit = Omit<Session, 'messages'> & { matches: readonly MatchExcerpt[]; subagentCount?: number };
export type WorkspaceChoice = { kind: 'source' | 'override'; path: string };
export interface ContinuationRequest {
  source: SessionSource;
  target: AgentId;
  workspace: WorkspaceChoice;
  currentRequest?: string;
  redactions?: readonly string[];
  fresh?: boolean;
}
export interface ContinuationSummary {
  source: SessionSource;
  target: AgentId;
  mode: 'native-resume' | 'fresh-handoff';
  workspace: string;
  includedItemIds: readonly string[];
  omittedItemIds: readonly string[];
  /** Exact final wire value and disclosure supplied by the composition service. */
  previewLines?: readonly string[];
}
export interface PreparedContinuation<Plan> {
  /** Opaque to the picker. The identical value is dispatched after confirmation. */
  plan: Plan;
  summary: ContinuationSummary;
}
/** Override streams only for embedding/testing. The caller owns the terminal. */
export interface PickerTerminal {
  input: ReadStream;
  output: WriteStream;
  signals: Pick<NodeJS.Process, 'on' | 'removeListener'>;
}
export interface PickerOptions<Plan> {
  workspace: string;
  scope?: Scope;
  label?: string;
  /** Enable request, literal-redaction and explicit fresh-context controls. */
  compose?: boolean;
  initialRequest?: string;
  notices?: () => readonly string[];
  checkNotice?: (signal: AbortSignal) => Promise<string | undefined>;
  terminal?: PickerTerminal;
  query(query: SessionQuery, signal: AbortSignal, publish: (hits: readonly SessionHit[]) => void): Promise<readonly SessionHit[]>;
  details?(source: SessionSource, signal: AbortSignal): Promise<readonly HistoryItem[]>;
  preview(source: SessionSource, signal: AbortSignal): Promise<readonly HistoryItem[]>;
  prepare(request: ContinuationRequest, signal: AbortSignal): Promise<PreparedContinuation<Plan>>;
  continue(plan: Plan): Promise<void>;
}
