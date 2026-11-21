import type { HistoryItem } from '../domain.js';
import { ReadContext } from './codex-io.js';
export type ObjectRecord = Record<string, unknown>;
export function object(value: unknown): ObjectRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectRecord : {};
}
export function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
export function textParts(value: unknown, tags: readonly string[]): string {
  if (!Array.isArray(value)) return '';
  return value.flatMap(part => {
    const item = object(part);
    return tags.includes(text(item.type)) && typeof item.text === 'string' ? [item.text] : [];
  }).join('\n');
}
function output(value: unknown): string {
  return typeof value === 'string' ? value : textParts(value, ['input_text']);
}
function status(value: unknown, ctx: ReadContext): HistoryItem['status'] {
  if (value === undefined || value === null || value === 'completed' || value === 'complete') return 'complete';
  if (value === 'failed' || value === 'declined') return 'failed';
  if (value === 'in_progress' || value === 'inProgress' || value === 'incomplete' || value === 'interrupted') return 'interrupted';
  ctx.add('unsupported-shape');
  return 'interrupted';
}
export interface SourceRecord { value: ObjectRecord; offset: number; end: number; line: number; source: string; ordinal?: number }
function nativeItemId(value: unknown): string {
  return typeof value === 'string' && /^[a-zA-Z0-9_:.\-]{1,256}$/.test(value) ? value : '';
}
function projectItem(item: ObjectRecord, record: SourceRecord, ctx: ReadContext, paginated: boolean): HistoryItem | undefined {
  let role: HistoryItem['role'] = 'tool', content = '';
  const type = text(item.type);
  if (paginated) {
    switch (type) {
      case 'UserMessage': role = 'user'; content = textParts(item.content, ['text']); break;
      case 'AgentMessage':
        if (object(item.moderation).moderated === true) return;
        role = 'assistant'; content = textParts(item.content, ['Text']); break;
      case 'Plan': role = 'assistant'; content = text(item.text); break;
      case 'CommandExecution': content = text(item.aggregated_output); break;
      case 'FunctionCallOutput': content = output(item.output); break;
      case 'DynamicToolCall': content = textParts(item.content_items, ['inputText']) || text(item.error); break;
      case 'McpToolCall': content = textParts(object(item.result).content, ['text']) || text(object(item.error).message); break;
      case 'Reasoning': case 'HookPrompt': case 'CollabAgentToolCall':
      case 'SubAgentActivity': case 'WebSearch': case 'ImageView': case 'Extension':
      case 'ImageGeneration': case 'EnteredReviewMode': case 'ExitedReviewMode':
      case 'FileChange': case 'ContextCompaction': return;
      default: ctx.add('unsupported-shape', 'history', record.line); return;
    }
  } else {
    switch (type) {
      case 'message':
        if (item.role !== 'user' && item.role !== 'assistant') return;
        role = item.role; content = textParts(item.content, role === 'user' ? ['input_text'] : ['output_text']); break;
      case 'function_call_output': case 'custom_tool_call_output': content = output(item.output); break;
      case 'mcp_tool_call_output': content = textParts(object(item.output).content, ['text']); break;
      default: return;
    }
  }
  if (!content) return;
  const id = nativeItemId(item.id) || nativeItemId(item.call_id) || `byte-${record.offset}`;
  return { id: `codex:${record.source}:${id}`, role, text: content, status: status(item.status, ctx) };
}
/** Public projection only: native context, instructions, reasoning and raw tool arguments are never traversed. */
export function project(records: readonly SourceRecord[], mode: string, ctx: ReadContext): HistoryItem[] {
  const projected: { item: HistoryItem; mirror: boolean }[] = [];
  for (const record of records) {
    const envelope = record.value, payload = object(envelope.payload);
    if (mode === 'paginated') {
      if (envelope.type === 'event_msg' && payload.type === 'item_completed') {
        const item = projectItem(object(payload.item), record, ctx, true);
        if (item) projected.push({ item, mirror: false });
      }
    } else if (envelope.type === 'response_item') {
      const item = projectItem(payload, record, ctx, false);
      if (item) projected.push({ item, mirror: false });
    } else if (envelope.type === 'event_msg' && (payload.type === 'user_message' || payload.type === 'agent_message')) {
      const message = text(payload.message);
      if (message) projected.push({ item: { id: `codex:${record.source}:byte-${record.offset}`, role: payload.type === 'user_message' ? 'user' : 'assistant', text: message, status: 'complete' }, mirror: true });
    }
  }
  // A legacy event and response may mirror the same text. Match occurrence counts,
  // retaining repeated real messages and event-only older histories.
  const counts = new Map<string, number>();
  const key = (item: HistoryItem) => JSON.stringify([item.role, item.text]);
  for (const entry of projected) if (!entry.mirror) counts.set(key(entry.item), (counts.get(key(entry.item)) ?? 0) + 1);
  const result: HistoryItem[] = [];
  const seen = new Set<string>();
  for (const entry of projected) {
    const count = counts.get(key(entry.item)) ?? 0;
    if (entry.mirror && count > 0) { counts.set(key(entry.item), count - 1); continue; }
    if (!seen.has(entry.item.id)) { result.push(entry.item); seen.add(entry.item.id); }
  }
  return result;
}
