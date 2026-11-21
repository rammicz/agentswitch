import type { HistoryItem } from '../domain.js';
import { ReadContext } from './codex-io.js';
import { object, text } from './claude-io.js';
import type { Entry, NativeRecord } from './claude-io.js';
export const graphTypes = new Set(['user', 'assistant', 'progress', 'system', 'attachment']);
export const metadataTypes = new Set(['summary', 'custom-title', 'ai-title', 'last-prompt', 'queue-operation', 'file-history-snapshot']);
export function visible(e: NativeRecord): boolean { return !e.isSidechain && !e.isMeta && !e.teamName; }
export function graphEntry(value: NativeRecord, line: number, nativeId: string, ctx: ReadContext): Entry | undefined {
  if (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || value.sessionId.toLowerCase() !== nativeId)) {
    ctx.add('invalid-owner', 'history', line); return;
  }
  if (!graphTypes.has(text(value.type))) {
    if (!metadataTypes.has(text(value.type))) ctx.add('unsupported-shape', 'history', line);
    return;
  }
  if (!text(value.uuid) || (value.parentUuid !== null && value.parentUuid !== undefined && (typeof value.parentUuid !== 'string' || !value.parentUuid))) {
    ctx.add('unsupported-shape', 'history', line); return;
  }
  if ((value.type === 'user' || value.type === 'assistant') && (!value.message || typeof value.message !== 'object' || Array.isArray(value.message))) {
    ctx.add('unsupported-shape', 'history', line); return;
  }
  return { ...value, uuid: text(value.uuid), parentUuid: text(value.parentUuid) || null, type: text(value.type), line };
}
function response(e: Entry): string { return e.type === 'assistant' ? text(object(e.message).id) : ''; }
function blocks(e: NativeRecord): NativeRecord[] {
  const content = object(e.message).content;
  return Array.isArray(content) ? content.map(object) : [];
}
function blockIds(e: Entry, type: string, field: string): string[] {
  return blocks(e).filter(b => b.type === type).map(b => text(b[field])).filter(Boolean);
}
function sameWriter(a: Entry, b: Entry): boolean {
  return Boolean(a.isSidechain) === Boolean(b.isSidechain) && a.agentId === b.agentId && a.teamName === b.teamName;
}
function chronological(a: Entry, b: Entry): number {
  return text(a.timestamp).localeCompare(text(b.timestamp)) || a.line - b.line;
}

/** Select the latest main leaf in file order, then recover its parallel response siblings. */
export function conversation(entries: readonly Entry[], ctx: ReadContext): Entry[] {
  const byId = new Map<string, Entry>();
  for (const e of entries) {
    if (byId.has(e.uuid)) { ctx.add('unsupported-shape', 'history', e.line); continue; }
    byId.set(e.uuid, e);
  }
  const parents = new Set([...byId.values()].map(e => e.parentUuid));
  let leaf: Entry | undefined, fallback: Entry | undefined;
  const visited = new Set<string>();
  for (const terminal of byId.values()) {
    if (parents.has(terminal.uuid)) continue;
    let current: Entry | undefined = terminal;
    while (current && !visited.has(current.uuid)) {
      visited.add(current.uuid);
      if (current.type === 'user' || current.type === 'assistant') {
        if (!fallback || current.line > fallback.line) fallback = current;
        if (visible(current) && (!leaf || current.line > leaf.line)) leaf = current;
        break;
      }
      current = current.parentUuid ? byId.get(current.parentUuid) : undefined;
    }
  }
  leaf ??= fallback;
  if (!leaf) {
    if (entries.some(e => visible(e) && (e.type === 'user' || e.type === 'assistant'))) ctx.add('ancestry-cycle');
    return [];
  }
  const chain: Entry[] = [], seen = new Set<string>();
  let current: Entry | undefined = leaf;
  while (current) {
    if (seen.has(current.uuid)) { ctx.add('ancestry-cycle', 'history', current.line); break; }
    chain.push(current); seen.add(current.uuid);
    if (!current.parentUuid) break;
    const parent = byId.get(current.parentUuid);
    if (!parent) { ctx.add('ancestry-unavailable', 'history', current.line); break; }
    current = parent;
  }
  chain.reverse();
  return recoverParallel(byId, chain, seen);
}

function recoverParallel(byId: Map<string, Entry>, chain: Entry[], seen: Set<string>): Entry[] {
  const anchors = new Map<string, Entry>(), groups = new Map<string, Entry[]>();
  const owners = new Map<string, Entry | null>(), results = new Map<string, Entry[]>();
  for (const e of chain) if (response(e)) anchors.set(response(e), e);
  if (!anchors.size) return chain;
  for (const e of byId.values()) {
    const id = response(e);
    if (!id || !visible(e)) continue;
    const anchor = anchors.get(id);
    if (anchor && !sameWriter(anchor, e)) continue;
    const group = groups.get(id) ?? []; group.push(e); groups.set(id, group);
    for (const call of blockIds(e, 'tool_use', 'id')) {
      const prior = owners.get(call);
      owners.set(call, prior === undefined || (prior !== null && response(prior) === id && sameWriter(prior, e)) ? e : null);
    }
  }
  for (const e of byId.values()) {
    if (e.type !== 'user' || !e.parentUuid || !visible(e) || !blockIds(e, 'tool_result', 'tool_use_id').length) continue;
    const candidates = new Set([e.parentUuid, text(e.sourceToolAssistantUUID)]);
    for (const call of blockIds(e, 'tool_result', 'tool_use_id')) {
      const owner = owners.get(call); if (owner) candidates.add(owner.uuid);
    }
    for (const candidate of candidates) {
      const owner = byId.get(candidate);
      if (!owner || !sameWriter(e, owner)) continue;
      const list = results.get(candidate) ?? []; list.push(e); results.set(candidate, list);
    }
  }
  const answeredOnChain = new Set(chain.flatMap(e => blockIds(e, 'tool_result', 'tool_use_id')));
  const inserts = new Map<string, Entry[]>();
  for (const [id, anchor] of anchors) {
    const group = groups.get(id) ?? [], members = new Set(group.map(e => e.uuid));
    const siblings = group.filter(e => !seen.has(e.uuid)).sort(chronological);
    const direct: Entry[] = [], stray: Entry[] = [], collected = new Set<string>();
    for (const member of group) for (const result of results.get(member.uuid) ?? []) {
      if (seen.has(result.uuid) || collected.has(result.uuid)) continue;
      collected.add(result.uuid);
      (result.parentUuid && members.has(result.parentUuid) ? direct : stray).push(result);
    }
    const answered = new Set([...answeredOnChain, ...direct.flatMap(e => blockIds(e, 'tool_result', 'tool_use_id'))]);
    for (const result of stray.sort((a, b) => a.line - b.line)) {
      const calls = blockIds(result, 'tool_result', 'tool_use_id');
      if (!calls.some(call => { const owner = owners.get(call); return !answered.has(call) && owner && members.has(owner.uuid); })) continue;
      direct.push(result); for (const call of calls) answered.add(call);
    }
    const recovered = [...siblings, ...direct.sort(chronological)];
    for (const e of recovered) seen.add(e.uuid);
    inserts.set(anchor.uuid, recovered);
  }
  return chain.flatMap(e => [e, ...(inserts.get(e.uuid) ?? [])]);
}

function interrupted(value: string): boolean {
  return /^\[Request interrupted by user(?: for tool use)?\]$/.test(value);
}
function projectedText(value: string, id: string, role: HistoryItem['role'], failed: boolean, ctx: ReadContext, line: number): HistoryItem {
  if (value.includes('<persisted-output>')) ctx.add('unsupported-shape', 'history', line);
  return { id, role, text: value, status: failed ? 'failed' : role === 'user' && interrupted(value) ? 'interrupted' : 'complete' };
}
/** Only explicit public text and inline textual tool results cross this boundary. */
export function project(entries: readonly Entry[], nativeId: string, ctx: ReadContext): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const e of entries) {
    if (!visible(e) || (e.type !== 'user' && e.type !== 'assistant')) continue;
    const content = object(e.message).content;
    const id = `claude:${nativeId}:${e.uuid}`;
    const role = e.type;
    if (typeof content === 'string') {
      if (content) items.push(projectedText(content, `${id}:block-0`, role, false, ctx, e.line));
    } else if (Array.isArray(content)) {
      content.forEach((value: unknown, index: number) => {
        const block = object(value), blockId = `${id}:block-${index}`;
        if (block.type === 'text' && typeof block.text === 'string') {
          if (block.text) items.push(projectedText(block.text, blockId, role, false, ctx, e.line));
        } else if (block.type === 'tool_result' && role === 'user') {
          if (typeof block.content === 'string') {
            if (block.content) items.push(projectedText(block.content, blockId, 'tool', block.is_error === true, ctx, e.line));
          } else if (Array.isArray(block.content)) {
            block.content.forEach((part: unknown, partIndex: number) => {
              const result = object(part);
              if (result.type === 'text' && typeof result.text === 'string') {
                if (result.text) items.push(projectedText(result.text, `${blockId}:text-${partIndex}`, 'tool', block.is_error === true, ctx, e.line));
              } else ctx.add('unsupported-shape', 'history', e.line);
            });
          } else if (block.content !== undefined && block.content !== null) ctx.add('unsupported-shape', 'history', e.line);
        } else if (!['thinking', 'redacted_thinking', 'tool_use'].includes(text(block.type))) ctx.add('unsupported-shape', 'history', e.line);
      });
    } else ctx.add('unsupported-shape', 'history', e.line);
  }
  return items;
}
