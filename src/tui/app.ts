import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentId, HistoryItem, Scope, Session, SessionQuery } from '../domain.js';
import { searchSessions } from '../search.js';
import { windowsConsoleMode } from '../windows-runtime.js';
import type { PickerOptions, PreparedContinuation, SessionHit, SessionSource, WorkspaceChoice } from './contracts.js';
export type * from './contracts.js';

const filters = ['all', 'codex', 'claude', 'opencode', 'agy', 'grok'] as const;
const targets: readonly AgentId[] = ['codex', 'claude', 'opencode', 'agy', 'grok'];
const sourceOf = ({ id, nativeId, agent }: SessionHit): SessionSource => ({ id, nativeId, agent });
// Untrusted controls stay visible as text and never reach the terminal as instructions.
const clean = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]|\p{Bidi_Control}/gu,
  character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
const wrap = (lines: readonly string[], width: number): string[] => lines.flatMap(line => {
  // Count every non-ASCII code point conservatively as two terminal cells. This
  // overestimates combining/ZWJ sequences rather than allowing terminal overflow.
  // Exact wire previews are JSON strings with unsafe controls visibly escaped.
  const characters = Array.from(clean(line)).flatMap(character => width === 1 && character.codePointAt(0)! > 0x7f
    ? Array.from(JSON.stringify(character).slice(1, -1).replace(/[^\x20-\x7e]/g,
      unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)) : [character]);
  const chunks: string[] = [];
  let chunk = ''; let cells = 0;
  for (const character of characters) {
    const size = character.codePointAt(0)! > 0x7f ? 2 : 1;
    if (cells + size > width) { chunks.push(chunk); chunk = ''; cells = 0; }
    chunk += character; cells += size;
  }
  chunks.push(chunk);
  return chunks;
});
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const cellCount = (text: string): number => Array.from(text).reduce((cells, char) => cells + (char.codePointAt(0)! > 0x7f ? 2 : 1), 0);
const fit = (text: string, width: number): string => {
  const line = wrap([text], width)[0]!;
  return line + ' '.repeat(Math.max(0, width - cellCount(line)));
};

function lastUsed(timestamp: string, now: number): string {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return 'Unknown';
  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes === 0) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 525_600) return `${Math.floor(minutes / 1_440)}d ago`;
  return `${Math.floor(minutes / 525_600)}y ago`;
}

function sessionList(hits: readonly SessionHit[], selected: number, text: string, width: number, height: number,
  details: readonly string[]): string[] {
  const sideBySide = width >= 96 && height >= 4;
  const detailRows = sideBySide ? height : height >= 8 ? Math.ceil(height / 2) : 0;
  const listRows = Math.max(1, (sideBySide ? height : height - detailRows) - 1);
  const listWidth = sideBySide ? Math.floor(width * 0.57) : width;
  const detailWidth = sideBySide ? width - listWidth - 3 : width;
  const ageWidth = 10;
  const now = Date.now();
  const start = Math.max(0, selected - listRows + 1);
  const row = (label: string, age: string) => listWidth > 32
    ? fit(label, listWidth - ageWidth - 1) + ' ' + age.padStart(ageWidth) : label;
  const list = [row('Sessions', 'Last used'), ...hits.slice(start, start + listRows).map((hit, i) =>
    row(`${start + i === selected ? '›' : ' '} ${hit.agent.padEnd(6)} ${searchResultLabel(hit, text)}`, lastUsed(hit.lastUsedAt ?? hit.updatedAt, now)))];
  if (!detailRows) return list;
  const hit = hits[selected]!;
  const timestamp = hit.lastUsedAt ?? hit.updatedAt;
  const exact = Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'Unknown';
  const match = hit.matches.find(item => item.field === 'message');
  const notes = [...wrap([hit.title], detailWidth).slice(0, 2), ...wrap([`Last used: ${exact}`], detailWidth),
    ...wrap([`Folder: ${hit.workspace}`], detailWidth).slice(0, 3),
    ...wrap(match ? [`Match (${match.role}): ${match.text.replace(/\s+/gu, ' ')}`] : details, detailWidth).slice(0, 6),
    ...wrap([`Session ID: ${hit.nativeId}`], detailWidth)];
  const pane = ['Details', ...notes].slice(0, detailRows);
  if (!sideBySide) return [...list, ...pane];
  return Array.from({ length: Math.max(list.length, pane.length) }, (_, i) =>
    `${fit(list[i] ?? '', listWidth)} | ${pane[i] ?? ''}`);
}

function searchResultLabel(hit: SessionHit, query: string): string {
  const match = hit.matches.find(item => item.field === 'message');
  const text = match?.text.replace(/\s+/gu, ' ').trim();
  const untitled = hit.title.endsWith(` ${hit.nativeId}`);
  if (!text) {
    const lookup = query.trim().toLowerCase();
    if (!untitled || (lookup && hit.nativeId.toLowerCase().includes(lookup))) return hit.title;
    return `${hit.title.slice(0, -hit.nativeId.length - 1)} · ${hit.nativeId.slice(-8)}`;
  }
  const needle = query.trim().replace(/\s+/gu, ' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const position = needle ? text.search(new RegExp(needle, 'iu')) : -1;
  const before = position < 0 ? [] : Array.from(text.slice(0, position));
  const excerpt = position < 0 ? text
    : (before.length > 20 ? '…' : '') + before.slice(-20).join('') + text.slice(position);
  return untitled ? excerpt : `${hit.title} · ${excerpt}`;
}

/** Offline-capable UI boundary; provider compatibility and context budgets belong to services. */
export async function runPicker<Plan>(options: PickerOptions<Plan>): Promise<void> {
  const { input, output, signals } = options.terminal ?? { input: process.stdin, output: process.stdout, signals: process };
  if (!input.isTTY || !output.isTTY) throw new Error('The picker requires an interactive terminal.');
  const query: SessionQuery = { text: '', agent: 'all', scope: options.scope ?? 'folder', workspace: options.workspace };
  let hits: readonly SessionHit[] = [];
  let selected = 0;
  let selectionMoved = false;
  let showingSources = false;
  let sourceOffset = 0;
  let target = 0;
  let stage: 'list' | 'preview' | 'target' | 'workspace' | 'request' | 'redaction' | 'summary' = 'list';
  let picked: SessionHit | undefined;
  let items: readonly HistoryItem[] = [];
  let offset = 0;
  let choice: WorkspaceChoice | undefined;
  let pathInput = '';
  let currentRequest = options.initialRequest ?? 'Continue the task from this conversation.';
  let redactionInput = '';
  let redactions: string[] = [];
  let fresh = false;
  let prepared: PreparedContinuation<Plan> | undefined;
  let busy = false;
  let notice = '';
  let updateNotice: string | undefined;
  const noticeController = new AbortController();
  let retry: (() => void) | undefined;
  let active = true;
  let generation = 0;
  let pending: AbortController | undefined;
  let dispatch: PreparedContinuation<Plan> | undefined;
  let detailRequest: AbortController | undefined;
  let detailId: string | undefined;
  let detailLines: readonly string[] = [];
  let clock: ReturnType<typeof setInterval> | undefined;
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing;
  const previousData = new Set(input.listeners('data'));
  const previousNewListener = new Set(input.listeners('newListener'));
  let terminalEntered = false;
  // ConPTY keeps its output channel open for the handoff on the primary screen.
  const alternateScreen = process.platform !== 'win32';
  const nativeWindowsConsole = !alternateScreen && !options.terminal;
  const consoleState = nativeWindowsConsole ? windowsConsoleMode() : undefined;
  if (nativeWindowsConsole && !consoleState) throw new Error('Cannot snapshot the Windows console. Launch agentswitch in a Windows terminal.');
  let setupStarted = false;
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((accept, reject) => { resolveDone = accept; rejectDone = reject; });

  const invalidate = (): void => { generation++; pending?.abort(); pending = undefined; busy = false; retry = undefined; };
  // Every exit, including partial setup, uses this path. Cleanup attempts are independent.
  const finish = (error?: unknown): void => {
    if (!active) return;
    active = false;
    detailRequest?.abort();
    clearInterval(clock);
    noticeController.abort();
    invalidate();
    let failure = error;
    const attempt = (action: () => void): void => { try { action(); } catch (caught) { failure ??= caught; } };
    attempt(() => { input.removeListener('keypress', onKey); input.removeListener('error', onError); });
    attempt(() => { signals.removeListener('SIGINT', onSignal); signals.removeListener('SIGTERM', onSignal); });
    attempt(() => { output.removeListener('resize', onResize); output.removeListener('error', onError); });
    if (setupStarted) {
      for (const listener of input.listeners('data')) if (!previousData.has(listener)) attempt(() => { input.removeListener('data', listener as (...args: unknown[]) => void); });
      for (const listener of input.listeners('newListener')) if (!previousNewListener.has(listener)) attempt(() => { input.removeListener('newListener', listener as (...args: unknown[]) => void); });
      if (!alternateScreen) attempt(() => { input.pause(); });
      attempt(() => { input.setRawMode(wasRaw); });
      attempt(() => { if (wasFlowing === true) input.resume(); else input.pause(); });
    }
    if (terminalEntered) attempt(() => { output.write(alternateScreen ? '\x1b[?25h\x1b[?1049l' : '\x1b[?25h\r\n'); });
    if (setupStarted && consoleState) attempt(() => {
      if (windowsConsoleMode(consoleState) !== 'ok') throw new Error('Cannot restore the Windows console flags. Reopen your terminal.');
    });
    if (failure !== undefined) rejectDone(failure); else resolveDone();
  };
  const draw = (): void => {
    if (!active) return;
    const width = Math.max(1, (output.columns || 80) - 1);
    const height = Math.max(1, output.rows || 24);
    const bodyRows = Math.max(1, height - 8);
    const sourceNotices = options.notices?.() ?? [];
    let body: string[];
    let footer: string;
    if (showingSources) {
      const lines = wrap(sourceNotices.length ? sourceNotices : ['No source warnings.'], width);
      sourceOffset = Math.max(0, Math.min(sourceOffset, lines.length - bodyRows));
      body = lines.slice(sourceOffset, sourceOffset + bodyRows);
      footer = '↑ ↓ Scroll · Esc back';
    } else if (stage === 'list') {
      const progress = query.text.trim() ? 'Searching history…' : 'Finding local sessions…';
      body = hits.length ? sessionList(hits, selected, query.text, width, bodyRows, detailLines)
        : [busy ? progress : 'No matching sessions. Clear the search or change scope.'];
      footer = '↑ ↓ Select · Enter preview · Esc quit';
      if (busy) footer = hits.length ? `↑ ↓ Select · Enter open session · Esc quit · ${progress}` : 'Esc quit';
    } else if (stage === 'preview') {
      const source = picked!;
      const provenance = `${source.agent}/${source.id}`;
      const lines = wrap([
        `Source: ${provenance} · ${source.title}`, `Workspace: ${source.workspace}`,
        ...source.matches.map(match => match.field === 'message'
          ? `Match ${provenance}/${match.itemId} [${match.role}]: ${match.text}`
          : `Match ${provenance} [${match.field}]: ${match.text}`),
        ...items.map(item => `${provenance}/${item.id} [${item.role}, ${item.status}]: ${item.text}`),
      ], width);
      offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - bodyRows)));
      body = lines.slice(offset, offset + bodyRows);
      footer = '↑ ↓ Scroll · Enter choose target · Esc back';
    } else if (stage === 'request' || stage === 'redaction') {
      body = [stage === 'request' ? 'Current request (sent separately from historical data):' : 'Literal redaction (replace every match before transfer retention):', stage === 'request' ? currentRequest : redactionInput, 'Enter save · Esc cancel'];
      footer = 'Backspace edit · Ctrl+U clear';
    } else if (stage === 'workspace') {
      body = ['Explicit workspace override:', pathInput || 'Type an absolute or relative directory path'];
      footer = 'Enter use this folder and prepare · Esc cancel override';
    } else if (stage === 'summary') {
      const summary = prepared!.summary;
      body = wrap([`Source: ${summary.source.agent}/${summary.source.id} (${summary.source.nativeId})`,
        `Target: ${summary.target}`, `Mode: ${summary.mode}`, `Workspace: ${summary.workspace}`,
        `Included: ${summary.includedItemIds.join(', ') || '(none)'}`, `Omitted: ${summary.omittedItemIds.join(', ') || '(none)'}`, ...(summary.previewLines ?? [])], width);
      // A long summary must remain inspectable before confirming.
      offset = Math.max(0, Math.min(offset, Math.max(0, body.length - bodyRows)));
      body = body.slice(offset, offset + bodyRows);
      footer = '↑ ↓ Scroll · Enter confirm continuation · Esc back';
    } else {
      body = [`Source: ${picked!.agent}/${picked!.id}`, `Target: ${targets[target]}  ← → change`,
        `Workspace: ${choice!.path} (${choice!.kind})`, 'W override workspace', ...(options.compose ? [`Current request: ${currentRequest}`, `Redactions: ${redactions.length} literal selection(s)`, `Fresh context: ${fresh ? 'explicitly selected' : 'automatic same-agent resume'}`, 'C edit request · X add redaction · F toggle fresh context'] : [])];
      footer = 'Enter prepare summary · Esc back';
    }
    const statusHint = stage === 'list' && sourceNotices.length ? 'F2 source status' : '';
    const retryHint = retry ? (stage === 'list' ? ' · Ctrl+R retry' : ' · R retry') : '';
    const lines = showingSources ? ['Source status', '', ...body, '', footer] : [options.label ?? 'agentswitch',
      `Search: ${query.text || 'type to search history…'}`, `← → Agent: ${query.agent}     Tab Scope: ${query.scope}`,
      '', ...body, '', busy && stage !== 'list' ? 'Loading… · Esc back' : footer,
      ...(stage === 'list' && updateNotice ? [updateNotice] : []), [notice + retryHint, statusHint].filter(Boolean).join(' · ')];
    const styledList = stage === 'list' && !showingSources && process.env.NO_COLOR === undefined;
    const frame = lines.slice(0, height).map((line, index) => {
      const clipped = wrap([line], width)[0]!;
      const emphasized = styledList && index >= 4 && /^(?:Sessions\b|Details\b|› )/.test(clipped);
      return emphasized ? `\x1b[1m${clipped}\x1b[22m` : clipped;
    });
    output.write('\x1b[2J\x1b[H' + frame.join('\n'));
  };
  const redraw = (): void => {
    try {
      const hit = active && stage === 'list' && !showingSources ? hits[selected] : undefined;
      if (hit?.id !== detailId) {
        detailRequest?.abort(); detailId = hit?.id; detailLines = [];
        const load = options.details;
        if (hit && load && !hit.matches.some(match => match.field === 'message')) {
          const controller = new AbortController();
          detailRequest = controller;
          void delay(150, undefined, { signal: controller.signal }).then(() => load(sourceOf(hit), controller.signal)).then(found => {
            if (controller.signal.aborted) return;
            detailLines = found.filter(item => item.status === 'complete' && item.role !== 'tool' && item.text.trim()).slice(0, 2).map(item => {
              const text = Array.from(item.text.replace(/\s+/gu, ' ').trim());
              return `${item.role === 'user' ? 'Opening request' : 'Reply'}: ${text.slice(0, 240).join('')}${text.length > 240 ? '…' : ''}`;
            });
            redraw();
          }).catch(() => { /* Metadata remains available if an excerpt cannot be read. */ });
        }
      }
      draw();
    } catch (error) { finish(error); }
  };
  const request = <T>(work: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void, again: () => void): void => {
    invalidate();
    const current = generation;
    const controller = new AbortController();
    pending = controller;
    busy = true;
    notice = '';
    redraw();
    if (!active) return;
    void Promise.resolve().then(async () => {
      if (!active || current !== generation) return;
      const value = await work(controller.signal);
      if (!active || current !== generation) return;
      busy = false;
      accept(value);
      redraw();
    }).catch(error => {
      if (!active || current !== generation) return;
      busy = false;
      notice = message(error);
      retry = again;
      redraw();
    });
  };
  const search = (): void => {
    hits = []; selected = 0; selectionMoved = false;
    const snapshot = { ...query };
    const show = (found: readonly SessionHit[]): void => {
      const id = selectionMoved ? hits[selected]?.id : undefined;
      hits = found;
      if (id) selected = Math.max(0, found.findIndex(hit => hit.id === id));
    };
    request(signal => options.query(snapshot, signal, found => {
      if (signal.aborted) return;
      show(found);
      redraw();
    }), show, search);
  };
  const preview = (): void => {
    const source = sourceOf(picked!);
    items = []; offset = 0;
    request(signal => options.preview(source, signal), found => { items = found; }, preview);
  };
  const prepare = (): void => {
    const requestValue = { source: sourceOf(picked!), target: targets[target]!, workspace: { ...choice! }, ...(options.compose ? {currentRequest, redactions: [...redactions], fresh} : {}) };
    request(async signal => {
      const directory = await stat(requestValue.workspace.path).catch(() => undefined);
      if (!directory?.isDirectory()) throw new Error(`Workspace unavailable: ${requestValue.workspace.path}. Press W to choose another folder.`);
      if (signal.aborted) throw new Error('Cancelled');
      return options.prepare(requestValue, signal);
    }, value => { prepared = value; stage = 'summary'; offset = 0; }, prepare);
  };
  const onError = (error: Error): void => finish(error);
  const onSignal = (): void => finish();
  const onResize = (): void => redraw();
  const onKey = (text: string | undefined, key: Key): void => {
    if (!active) return;
    try {
      if (key.ctrl && key.name === 'c') { finish(); return; }
      if (showingSources) {
        if (key.name === 'escape' || key.name === 'f2') showingSources = false;
        else if (key.name === 'up') sourceOffset--;
        else if (key.name === 'down') sourceOffset++;
        redraw(); return;
      }
      if (stage === 'list' && key.name === 'f2' && options.notices) {
        showingSources = true; sourceOffset = 0; redraw(); return;
      }
      if (key.name === 'escape') {
        invalidate(); notice = '';
        if (stage === 'list') { finish(); return; }
        if (stage === 'workspace' || stage === 'summary' || stage === 'request' || stage === 'redaction') stage = 'target';
        else if (stage === 'target') { stage = 'preview'; preview(); return; }
        else { stage = 'list'; search(); return; }
      } else if (stage === 'request' || stage === 'redaction') {
        if (key.name === 'return') { if (stage === 'redaction' && redactionInput) { redactions.push(redactionInput); redactionInput=''; } stage='target'; }
        else {
          let value = stage === 'request' ? currentRequest : redactionInput;
          if (key.ctrl && key.name === 'u') value='';
          else if (key.name === 'backspace') value=Array.from(value).slice(0,-1).join('');
          else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f-\x9f]/.test(text)) value+=text;
          if (stage === 'request') currentRequest=value; else redactionInput=value;
        }
      } else if (stage === 'workspace') {
        if (key.name === 'return' && pathInput.trim()) {
          choice = { kind: 'override', path: resolve(options.workspace, pathInput.trim()) };
          stage = 'target'; prepare(); return;
        }
        if (key.name === 'backspace') pathInput = Array.from(pathInput).slice(0, -1).join('');
        else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f-\x9f]/.test(text)) pathInput += text;
      } else if (retry && key.name === 'r' && stage !== 'list') { retry(); return; }
      else if (stage === 'list') {
        if (key.name === 'left' || key.name === 'right') {
          query.agent = filters[(filters.indexOf(query.agent) + (key.name === 'left' ? -1 : 1) + filters.length) % filters.length]!;
          search(); return;
        }
        if (key.name === 'tab') { query.scope = query.scope === 'folder' ? 'global' : 'folder'; search(); return; }
        if (key.name === 'up' || key.name === 'down') {
          selected = Math.max(0, Math.min(hits.length - 1, selected + (key.name === 'up' ? -1 : 1)));
          selectionMoved = hits.length > 0;
        }
        else if (key.name === 'return' && hits[selected]) { picked = hits[selected]; stage = 'preview'; preview(); return; }
        else if (key.name === 'backspace') { query.text = Array.from(query.text).slice(0, -1).join(''); search(); return; }
        else if (retry && key.ctrl && key.name === 'r') { retry(); return; }
        else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f-\x9f]/.test(text)) { query.text += text; search(); return; }
      } else if (stage === 'preview') {
        if (key.name === 'up') offset--;
        else if (key.name === 'down') offset++;
        else if (key.name === 'return' && !busy && !retry) {
          stage = 'target'; target = 0; choice = { kind: 'source', path: picked!.workspace };
        }
      } else if (stage === 'target') {
        if (key.name === 'left' || key.name === 'right') { invalidate(); target = (target + (key.name === 'left' ? -1 : 1) + targets.length) % targets.length; notice = ''; }
        else if (options.compose && key.name === 'c') { invalidate(); notice=''; stage='request'; }
        else if (options.compose && key.name === 'x') { invalidate(); notice=''; redactionInput=''; stage='redaction'; }
        else if (options.compose && key.name === 'f') { invalidate(); fresh=!fresh; notice=''; }
        else if (key.name === 'w') { invalidate(); notice = ''; pathInput = ''; stage = 'workspace'; }
        else if (key.name === 'return' && !busy) { prepare(); return; }
      } else if (stage === 'summary') {
        if (key.name === 'up') offset--;
        else if (key.name === 'down') offset++;
        else if (key.name === 'return') { dispatch = prepared; finish(); return; }
      }
      redraw();
    } catch (error) { finish(error); }
  };
  try {
    setupStarted = true;
    emitKeypressEvents(input);
    input.on('keypress', onKey);
    input.on('error', onError);
    output.on('error', onError);
    signals.on('SIGINT', onSignal);
    signals.on('SIGTERM', onSignal);
    output.on('resize', onResize);
    input.setRawMode(true);
    input.resume();
    terminalEntered = true;
    output.write(alternateScreen ? '\x1b[?1049h\x1b[?25l' : '\x1b[?25l');
    search();
    clock = setInterval(() => { if (stage === 'list' && !showingSources) redraw(); }, 60_000).unref();
    const check = options.checkNotice;
    if (check) void Promise.resolve().then(() => check(noticeController.signal)).then(result => {
      if (!active || !result) return;
      updateNotice = result;
      redraw();
    }).catch(() => { /* Update checks are best effort and leave the picker usable offline. */ });
  } catch (error) { finish(error); }
  await done;
  if (dispatch) await options.continue(dispatch.plan);
}

/** Synthetic services only: this path never reads history or launches an agent. */
export async function runDemo(sessions: readonly Session[], workspace: string, scope: Scope = 'folder'): Promise<void> {
  await runPicker({ workspace, scope, label: 'agentswitch / DEMO — synthetic sessions',
    query: async query => searchSessions(sessions, query).map(({ messages, ...session }) => ({ ...session,
      matches: query.text.trim() ? messages.filter(item => item.text.toLocaleLowerCase().includes(query.text.trim().toLocaleLowerCase()))
        .map(item => ({ field: 'message' as const, itemId: item.id, role: item.role, text: item.text })) : [],
    })),
    details: async source => sessions.find(session => session.id === source.id && session.agent === source.agent)?.messages ?? [],
    preview: async source => sessions.find(session => session.id === source.id && session.agent === source.agent)?.messages ?? [],
    prepare: async request => ({ plan: request, summary: { source: request.source, target: request.target,
      mode: 'fresh-handoff', workspace: request.workspace.path,
      includedItemIds: sessions.find(session => session.id === request.source.id)?.messages.map(item => item.id) ?? [], omittedItemIds: [] } }),
    continue: async () => { console.log('Demo only. No agent launched; handoff is planned.'); },
  });
}
