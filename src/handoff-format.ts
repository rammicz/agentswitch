import type { AgentId, HistoryItem } from './domain.js';

// Dependency-free on purpose: the picker and continuity readers use it without loading the runtime.
export const HANDOFF_FORMAT_V1 = 'agentswitch-historical-context-v1';
export const HANDOFF_FORMAT = 'agentswitch-historical-context-v2';
export const DEFAULT_CURRENT_REQUEST = 'Review the historical context and current workspace state. If work is unfinished, continue it; if the last turn already completed, summarize where things stand and confirm next steps.';

type Origin = { agent: AgentId; context: string };
export interface ParsedHandoffPrompt {
  format: typeof HANDOFF_FORMAT_V1 | typeof HANDOFF_FORMAT;
  currentRequest: string;
  /** Normalized items: default `complete` status and `origins[o]` restored as `origin`. */
  history: HistoryItem[];
}
interface WireItem { id: string; role: HistoryItem['role']; text: string; status?: HistoryItem['status']; o?: number }

function invalid(): never { throw new Error('Invalid stored handoff prompt.'); }

/** Decode a stored handoff prompt of either envelope version. Item contents are validated later by the archive schema. */
export function parseHandoffPrompt(prompt: string): ParsedHandoffPrompt {
  const envelope = JSON.parse(prompt) as { format?: unknown; currentRequest?: unknown; history?: unknown; origins?: unknown };
  const { format, currentRequest, history } = envelope;
  if ((format !== HANDOFF_FORMAT_V1 && format !== HANDOFF_FORMAT) || typeof currentRequest !== 'string' || !Array.isArray(history)) invalid();
  if (format === HANDOFF_FORMAT_V1) return { format, currentRequest, history: history as HistoryItem[] };
  const origins = envelope.origins ?? [];
  if (!Array.isArray(origins)) invalid();
  return { format, currentRequest, history: (history as WireItem[]).map(({ id, role, text, status, o }) => {
    if (o !== undefined && (!Number.isInteger(o) || o < 0 || o >= origins.length)) invalid();
    return { id, role, text, status: status ?? 'complete', ...(o === undefined ? {} : { origin: origins[o] as Origin }) };
  }) };
}
