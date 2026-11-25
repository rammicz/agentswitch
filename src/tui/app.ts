import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentId, HistoryItem, Scope, Session, SessionQuery } from '../domain.js';
import { DEFAULT_CURRENT_REQUEST } from '../handoff-format.js';
import { searchSessions } from '../search.js';
import { windowsConsoleMode } from '../windows-runtime.js';
import type { ContinuationRequest, PickerOptions, PreparedContinuation, SessionHit, SessionSource, WorkspaceChoice } from './contracts.js';
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
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function terminalWidth(grapheme: string): number {
  if (/^[\p{Mark}\p{Cf}]+$/u.test(grapheme)) return 0;
  if (/\p{Emoji_Presentation}|\uFE0F|\u20E3/u.test(grapheme)) return 2;
  const code = grapheme.codePointAt(0)!;
  return code >= 0x1100 && (code <= 0x115F || code === 0x2329 || code === 0x232A ||
    (code >= 0x2E80 && code <= 0xA4CF && code !== 0x303F) || (code >= 0xAC00 && code <= 0xD7A3) ||
    (code >= 0xF900 && code <= 0xFAFF) || (code >= 0xFE10 && code <= 0xFE6F) ||
    (code >= 0xFF01 && code <= 0xFF60) || (code >= 0xFFE0 && code <= 0xFFE6) || code >= 0x20000) ? 2 : 1;
}
const printableAscii = /^[\x20-\x7e]*$/;
const cellCount = (text: string): number => printableAscii.test(text) ? text.length
  : [...graphemes.segment(text)].reduce((cells, {segment}) => cells + terminalWidth(segment), 0);
function panelWrap(text: string, width: number): string[] {
  // Printable ASCII is one cell per character and needs no escaping or segmentation.
  if (width >= 1 && printableAscii.test(text)) return Array.from({ length: Math.max(1, Math.ceil(text.length / width)) }, (_, i) => text.slice(i * width, (i + 1) * width));
  const lines: string[] = [];
  let row = '', cells = 0;
  for (const { segment } of graphemes.segment(clean(text))) {
    const size = terminalWidth(segment);
    if (size > width) continue;
    if (cells + size > width) { lines.push(row); row = ''; cells = 0; }
    row += segment;
    cells += size;
  }
  return [...lines, row];
}
/** Like panelWrap, but breaks after spaces where it can; a word wider than the row is split. */
function wordWrap(text: string, width: number): string[] {
  const rows: string[] = [];
  let row = '', cells = 0;
  for (const word of clean(text).split(/(?<= )/)) {
    const size = cellCount(word);
    const visible = size - (word.length - word.trimEnd().length);
    if (row && cells + visible > width) { rows.push(row.trimEnd()); row = ''; cells = 0; }
    if (visible > width) {
      const parts = panelWrap(word, width);
      rows.push(...parts.slice(0, -1));
      row = parts.at(-1)!; cells = cellCount(row);
    } else { row += word; cells += size; }
  }
  return [...rows, row.trimEnd()];
}
/** Prose wrapped between words, every row in one tone. */
const prose = (text: string, width: number, tone: Tone | readonly Tone[], color: boolean): string[] =>
  wordWrap(text, width).map(row => styled(row, tone, color));
function clipPanel(text: string, width: number): string {
  const lines = panelWrap(text, width);
  return lines.length === 1 ? lines[0]! : `${panelWrap(lines[0]!, width - 1)[0]!.trimEnd()}…`;
}
/** The picker's one semantic palette (truecolor SGR). NO_COLOR or TERM=dumb renders the same rows without it. */
const palette = {
  accent: '38;2;215;119;87',
  heading: '1;38;2;215;119;87',
  key: '1;38;2;215;119;87',
  title: '1',
  muted: '38;2;150;150;162',
  selectedBg: '48;2;52;52;66',
  success: '38;2;135;200;130',
  warning: '38;2;235;200;110',
  error: '38;2;240;110;120',
  highlight: '1;38;2;30;30;46;48;2;235;200;110',
  codex: '38;2;125;174;250',
  claude: '38;2;232;160;113',
  opencode: '38;2;158;206;106',
  agy: '38;2;187;154;247',
  grok: '38;2;115;218;202',
} satisfies Record<string, string>;
type Tone = keyof typeof palette;
function styled(text: string, tone: Tone | readonly Tone[], color: boolean): string {
  const tones = [tone].flat();
  return color && text && tones.length ? `\x1b[${tones.map(name => palette[name]).join(';')}m${text}\x1b[0m` : text;
}
type Hint = readonly [key: string, action: string];
/** Key hints as keycaps, the key in bold accent and its action muted, two cells apart. Hints that do not fit continue on
 * another row rather than being dropped, so every key a screen accepts stays listed. */
function keycaps(hints: readonly Hint[], width: number, color: boolean): string[] {
  const rows: string[] = [];
  let row = '', cells = 0;
  for (const [key, action] of hints) {
    const plain = key ? `${key} ${action}` : action;
    const size = cellCount(plain);
    if (row && cells + 2 + size > width) { rows.push(row); row = ''; cells = 0; }
    const hint = size > width ? styled(clipPanel(plain, width), 'muted', color)
      : key ? styled(key, 'key', color) + styled(` ${action}`, 'muted', color) : styled(action, 'muted', color);
    row += (row ? '  ' : '') + hint;
    cells += (cells ? 2 : 0) + Math.min(size, width);
  }
  return row ? [...rows, row] : rows;
}
/** A muted label and its plain value two spaces apart, wrapped to at most `limit` rows. */
function pair(label: string, value: string, width: number, color: boolean, limit = Infinity): string[] {
  // Words wrap whole, but a value with no break that fits after the label (a path, say) starts beside it rather than below.
  const words = wordWrap(`${label}  ${value}`, width);
  return (words[0] === label && value ? panelWrap(`${label}  ${value}`, width) : words).slice(0, limit)
    .map((row, index) => index === 0 && row.startsWith(label) ? styled(label, 'muted', color) + row.slice(label.length) : row);
}
/** One input row. Text that does not fit shows its end after `…`, so the typing position stays visible. */
function inputRow(text: string, width: number): string {
  const escaped = clean(text);
  if (cellCount(escaped) <= width) return escaped;
  // Only the end is shown; a cell is at most a few code units, and the first, possibly cut, grapheme is skipped.
  const segments = Array.from(graphemes.segment(escaped.slice(-(width * 8 + 16))), ({ segment }) => segment);
  let row = '', cells = 0;
  for (let index = segments.length - 1; index > 0; index--) {
    const size = terminalWidth(segments[index]!);
    if (cells + size > width - 1) break;
    row = segments[index] + row; cells += size;
  }
  return `…${row}`;
}
/**
 * A folder on one row of `width` cells: the home directory becomes `~`, and a path that still does not fit keeps its
 * first segment and as many final segments as fit, with `…` between them. Screens with room show the full path.
 */
export function compactPath(path: string, width: number, home = homedir()): string {
  const short = home && home !== sep && (path === home || path.startsWith(home + sep)) ? `~${path.slice(home.length)}` : path;
  if (cellCount(clean(short)) <= width) return clean(short);
  const parts = short.split(sep);
  // An absolute path keeps its first directory (`/Users`), a home-relative one its `~`.
  const head = parts[0] === '' ? `${sep}${parts[1] ?? ''}` : parts[0]!;
  const rest = parts.slice(parts[0] === '' ? 2 : 1);
  let tail = '';
  for (let index = rest.length - 1; index > 0; index--) {
    const next = tail ? `${rest[index]}${sep}${tail}` : rest[index]!;
    if (cellCount(clean(`${head}${sep}…${sep}${next}`)) > width) break;
    tail = next;
  }
  return tail ? clean(`${head}${sep}…${sep}${tail}`) : inputRow(short, width);
}
const indent = (rows: readonly string[]): string[] => rows.map(row => `  ${row}`);
/** Claude Code wraps slash commands in markup; show them as typed (`/name args`). Other text is unchanged. */
function readableRequest(text: string): string {
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1];
  if (!name) return text;
  const args = /<command-args>\s*([\s\S]*?)\s*<\/command-args>/.exec(text)?.[1] ?? '';
  return `${name.startsWith('/') ? name : `/${name}`}${args ? ` ${args}` : ''}`;
}

const exactTime = (timestamp: string): string => Number.isFinite(Date.parse(timestamp))
  ? new Date(timestamp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'Unknown';
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
/** Case-insensitive literal pattern for a search query, with runs of whitespace treated as one space. */
const queryPattern = (query: string, flags: string): RegExp | undefined => {
  const needle = query.trim().replace(/\s+/gu, ' ');
  return needle ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags) : undefined;
};
/** Paint a body row, wrapping each match of `pattern` in the highlight tone. */
function highlightRow(row: string, tone: Tone | undefined, pattern: RegExp | undefined, color: boolean): string {
  const base = (text: string) => text && tone ? styled(text, tone, color) : text;
  if (!color || !pattern) return base(row);
  let painted = '', last = 0;
  for (const found of row.matchAll(pattern)) {
    painted += base(row.slice(last, found.index)) + styled(found[0], 'highlight', color);
    last = found.index + found[0].length;
  }
  return painted + base(row.slice(last));
}
/** The preview's session summary. Rebuilt on each draw so the relative time stays current. */
function sessionHeader(source: SessionHit, items: readonly HistoryItem[], width: number, color: boolean, loading: boolean): string[] {
  const time = source.lastUsedAt ?? source.updatedAt;
  const counts = (['user', 'assistant', 'tool'] as const).map(role => `${items.filter(item => item.role === role).length} ${role}`);
  const rows = [...prose(source.title, width, 'title', color), ...[`Agent: ${source.agent}`, `Folder: ${compactPath(source.workspace, Math.max(1, width - 'Folder: '.length))}`,
    `Last used: ${lastUsed(time, Date.now())} (${exactTime(time)})`, `Session ID: ${source.nativeId}`,
    [plural(items.length, 'item'), ...counts].join(' · ')].flatMap(label => prose(label, width, 'muted', color))];
  if (!items.length && !loading) rows.push('', ...prose('No readable conversation in this session (metadata only).', width, 'muted', color));
  return rows;
}
/**
 * The preview's transcript: one block per item, a role header with its text indented below and a blank row before it.
 * Line breaks become rows and tabs two spaces; every other control stays visibly escaped. Rows already fit `width`.
 * `focus` is the row of the first matched item's header, if any.
 */
function transcriptBlocks(source: SessionHit, items: readonly HistoryItem[], width: number, color: boolean,
  expandTools: boolean, query: string): { rows: string[]; focus: number | undefined } {
  const rows: string[] = [];
  const matched = source.matches.find(match => match.field === 'message')?.itemId;
  const pattern = queryPattern(query, 'giu');
  const textWidth = Math.max(1, width - 2);
  const pushRow = (row: string, tone?: Tone) => rows.push('  ' + highlightRow(row, tone, pattern, color));
  let focus: number | undefined;
  for (const item of items) {
    rows.push('');
    if (item.id === matched) focus = rows.length;
    const lines = item.text.replace(/\r\n/g, '\n').replace(/\t/g, '  ').split('\n');
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    const tool = item.role === 'tool';
    const label = tool ? `⏺ tool output · ${plural(lines.length, 'line')}` : item.role === 'user' ? '● You' : `● ${source.agent}`;
    const tone: Tone | Tone[] = item.role === 'tool' ? 'muted' : item.role === 'user' ? 'title' : ['title', source.agent];
    const tag = item.status === 'complete' ? '' : `  ${item.status}`;
    // The status tag keeps at least one label cell beside it; a row too narrow for both clips them together.
    rows.push(width > tag.length ? styled(clipPanel(label, width - tag.length), tone, color) + (tag && styled(tag, item.status === 'failed' ? 'error' : 'warning', color))
      : styled(clipPanel(label + tag, width), tone, color));
    if (!tool || expandTools) { for (const text of lines) for (const row of wordWrap(text, textWidth)) pushRow(row, tool ? 'muted' : undefined); continue; }
    // Collapsed tool output: the first three non-empty lines, one row each.
    const shown = lines.flatMap((text, index) => text.trim() ? [index] : []).slice(0, 3);
    for (const index of shown) pushRow(clipPanel(lines[index]!, textWidth), 'muted');
    const rest = lines.length - 1 - (shown.at(-1) ?? -1);
    if (rest > 0) rows.push(styled(clipPanel(`  … ${plural(rest, 'more line')}`, width), 'muted', color));
  }
  return { rows, focus };
}

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

// The widest list row each search result set needs (marker, agent, title, arrow, then the widest age, 8 cells), measured
// once per set so that a clock redraw neither remeasures nor resizes it.
const neededWidths = new WeakMap<readonly SessionHit[], { key: string; width: number }>();
function sessionList(hits: readonly SessionHit[], selected: number, text: string, width: number, height: number,
  details: readonly string[], color: boolean, workspace: string): string[] {
  const sideBySide = selected >= 0 && width >= 96 && height >= 4;
  const share = selected < 0 || sideBySide || height < 8 ? 0 : Math.max(5, Math.floor(height * 0.47));
  // Stacked, the details take their share of the rows, and also the rows a shorter list leaves.
  const listRows = sideBySide ? height : share ? Math.max(1, Math.min(hits.length, height - share - 1)) : Math.max(1, height);
  const detailRows = selected < 0 ? 0 : sideBySide ? height : share ? height - 1 - listRows : 0;
  const now = Date.now();
  const ageOf = (hit: SessionHit) => lastUsed(hit.lastUsedAt ?? hit.updatedAt, now);
  const prefixOf = (hit: SessionHit, marker: string) => `${marker} ${hit.agent.padEnd(6)} `;
  const childrenOf = (hit: SessionHit) => hit.subagentCount ? '  →' : '';
  const elsewhereOf = (hit: SessionHit) => hit.workspace === workspace ? '' : `  ${basename(hit.workspace) || hit.workspace}`;
  let needed = neededWidths.get(hits);
  if (needed?.key !== `${workspace}\0${text}`) {
    needed = { key: `${workspace}\0${text}`, width: hits.reduce((most, hit) => Math.max(most, cellCount(prefixOf(hit, ' ') + searchResultLabel(hit, text) + elsewhereOf(hit) + childrenOf(hit))), 0) + 2 + 8 };
    neededWidths.set(hits, needed);
  }
  // Side by side, the list widens to fit its rows while the details pane keeps at least 40 cells.
  const least = Math.floor(width * 0.43);
  // Stacked, it ends after its widest row, so the age stays near the title.
  const listWidth = sideBySide ? Math.min(Math.max(least, width - 43), Math.max(least, needed.width)) : Math.min(width, needed.width);
  const detailWidth = sideBySide ? width - listWidth - 3 : width;
  const start = Math.max(0, selected - listRows + 1);
  // Each row fills listWidth: marker, agent, title, then the age right-aligned.
  const list = hits.slice(start, start + listRows).map((hit, i) => {
    const chosen = start + i === selected;
    const paint = (part: string, ...tones: Tone[]) => styled(part, chosen ? ['selectedBg', ...tones] : tones, color);
    const age = width >= 25 ? ageOf(hit) : '';
    const marker = chosen ? '›' : hit.subagent ? '↳' : ' ';
    const children = childrenOf(hit);
    const prefix = prefixOf(hit, marker);
    const room = Math.max(1, listWidth - (age ? cellCount(age) + 2 : 0) - cellCount(children));
    const whole = prefix + searchResultLabel(hit, text), elsewhere = elsewhereOf(hit);
    // A result from another folder keeps its folder name in view; the title gives up cells first, down to two thirds.
    const folderRoom = !elsewhere ? 0 : Math.min(cellCount(elsewhere), Math.max(room - cellCount(whole), Math.floor(room / 3)));
    const folder = folderRoom >= 4 ? clipPanel(elsewhere, folderRoom) : '';
    const label = clipPanel(whole, Math.max(1, room - cellCount(folder)));
    const pad = ' '.repeat(Math.max(0, listWidth - cellCount(label + folder + children) - cellCount(age)));
    const title = label.startsWith(prefix)
      ? paint(`${marker} `, chosen ? 'accent' : 'muted') + paint(`${hit.agent.padEnd(6)} `, hit.agent) + paint(label.slice(prefix.length))
      : paint(label);
    return title + paint(folder, 'muted') + paint(children, 'muted') + paint(pad) + paint(age, 'muted');
  });
  if (!detailRows) return list;
  const hit = hits[selected]!;
  const match = hit.matches.find(item => item.field === 'message');
  const excerptRows = (match ? [`Match (${match.role}): ${match.text.replace(/\s+/gu, ' ')}`] : details).flatMap(line => wordWrap(line, detailWidth));
  const excerpts = excerptRows.slice(0, 7);
  const full = [styled('Details', 'heading', color), ...wordWrap(hit.title, detailWidth).slice(0, 2).map(row => styled(row, 'title', color)), '',
    ...pair('Last used', exactTime(hit.lastUsedAt ?? hit.updatedAt), detailWidth, color),
    ...pair('Folder', compactPath(hit.workspace, Math.max(1, detailWidth - 'Folder  '.length)), detailWidth, color),
    ...pair('Session ID', hit.nativeId, detailWidth, color, 2),
    ...(hit.subagentCount ? pair('Subagents', `${hit.subagentCount}  → open`, detailWidth, color) : []),
    ...(excerpts.length ? ['', ...excerpts] : [])];
  // A short pane gives up its spacing before its content.
  const fitting = full.length > detailRows ? full.filter(Boolean) : full;
  const pane = fitting.slice(0, detailRows);
  // An excerpt cut short, by the pane or the seven-row limit, ends with `…`.
  const cut = fitting.length > pane.length || excerptRows.length > excerpts.length;
  if (cut && pane.length > fitting.length - excerpts.length) pane[pane.length - 1] = clipPanel(`${pane.at(-1)!} …`, detailWidth);
  if (!sideBySide) return [...list, '', ...pane];
  const blank = ' '.repeat(listWidth);
  return Array.from({ length: Math.max(list.length, pane.length) }, (_, i) => `${list[i] ?? blank} ${styled('│', 'muted', color)} ${pane[i] ?? ''}`);
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
  const pattern = queryPattern(query, 'iu');
  const position = pattern ? text.search(pattern) : -1;
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
  const parents: { id: string; title: string; search: string }[] = [];
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
  let expandTools = false;
  let focusMatch = false;
  let pageRows = 1;
  // Scrolling redraws often; the wrapped transcript is rebuilt only when its inputs change.
  let blocks: { inputs: unknown[]; value: ReturnType<typeof transcriptBlocks> } | undefined;
  let choice: WorkspaceChoice | undefined;
  let pathInput = '';
  let currentRequest = options.initialRequest ?? DEFAULT_CURRENT_REQUEST;
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
  // The target screen's outcome for one request key; `shown` is unset while the service decides.
  let outcome: { key: string; shown?: { text: string; tone: Tone | readonly Tone[] } } | undefined;
  let outcomeRequest: AbortController | undefined;
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
    outcomeRequest?.abort();
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
    // One cell of left margin, and the last column stays free so a full row never wraps.
    const width = Math.max(1, (output.columns || 80) - 2);
    const height = Math.max(1, output.rows || 24);
    const color = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
    const inList = stage === 'list' && !showingSources;
    const sourceNotices = options.notices?.() ?? [];
    const parent = parents.at(-1);
    const searchFocused = selected < 0 || !hits.length;
    const heading = prose(showingSources ? 'Source status' : stage === 'target' ? 'Choose target'
      : inList && parent ? `Subagents of ${parent.title}` : options.label ?? 'agentswitch', width, 'heading', color);
    // Every row below is built to fit `width` and escaped by its stage; the frame only adds the margin.
    let header = [...heading, ''];
    if (inList) {
      const prompt = `${searchFocused ? '›' : ' '} Search: `;
      const search = prompt + (query.text ? inputRow(query.text, Math.max(1, width - prompt.length)) : 'type to search history…');
      header = [...heading, ...keycaps(parent ? [['←', 'Back to parent']] : [['Shift+←/→', `Agent: ${query.agent}`], ['Tab', `Scope: ${query.scope}`]], width, color),
        '', searchFocused ? styled(clipPanel(search, width), 'selectedBg', color) : clipPanel(search, width), ''];
    }
    const hints: Hint[] = inList ? [
      ...(parent ? [] : [['F3', `${query.includeSubagents ? 'hide' : 'show'} subagents`] as const]),
      ...(sourceNotices.length ? [['F2', 'source status'] as const] : []),
    ] : [];
    if (retry && !showingSources) hints.push(inList ? ['Ctrl+R', 'retry'] : ['R', 'retry']);
    const status = [
      ...(inList && updateNotice ? wordWrap(updateNotice, width) : []),
      ...(notice && !showingSources ? notice.split('\n').flatMap(line => wordWrap(line, width)) : []),
      ...keycaps(hints, width, color),
    ].slice(0, Math.max(0, height - header.length - 3));
    const progress = query.text.trim() ? 'Searching history…' : 'Finding local sessions…';
    const inner = Math.max(1, width - 2);
    const section = (title: string) => styled(title, 'title', color);
    // A scrolling stage sets `rows`, all of its content, and `scroll`, its offset variable and the hint shown, at
    // `at` in the footer, while the content is taller than the body. The list instead lays itself out for the body.
    let rows: string[] = [];
    let footer: Hint[] = [];
    let scroll: { source: boolean; hint: Hint; at: number } | undefined;
    if (showingSources) {
      rows = wrap(sourceNotices.length ? sourceNotices : ['No source warnings.'], width);
      footer = [['Esc', 'back']];
      scroll = { source: true, hint: ['↑↓', 'scroll'], at: 0 };
    } else if (stage === 'list') {
      const back: Hint = parents.length ? ['←', 'back'] : ['Esc', 'quit'];
      // Only keys that do something: with no results there is nothing to select or preview.
      footer = hits.length ? selected < 0 ? [['↓', 'results'], back] : [['↑↓', 'select'], ['Enter', 'preview'], back]
        : query.text ? [['Ctrl+U', 'clear search'], back] : [back];
      if (busy) footer = hits.length ? [['↑↓', 'select'], ['Enter', 'open session'], back, ['', progress]] : [back];
    } else if (stage === 'preview') {
      const inputs = [picked, items, width, color, expandTools, query.text];
      if (!blocks || inputs.some((input, index) => input !== blocks!.inputs[index])) blocks = { inputs, value: transcriptBlocks(picked!, items, width, color, expandTools, query.text) };
      const head = sessionHeader(picked!, items, width, color, busy);
      rows = [...head, ...blocks.value.rows];
      if (focusMatch && items.length) {
        if (blocks.value.focus !== undefined) offset = head.length + blocks.value.focus;
        focusMatch = false;
      }
      footer = [['Enter', 'choose target'], ['Esc', 'back'],
        ...(items.some(item => item.role === 'tool') ? [['T', `${expandTools ? 'hide' : 'show'} tool output`] as const] : [])];
      scroll = { source: false, hint: ['↑↓ PgUp PgDn', 'scroll'], at: 2 };
    } else if (stage === 'request' || stage === 'redaction') {
      const value = stage === 'request' ? currentRequest : redactionInput;
      rows = [...wordWrap(stage === 'request' ? 'Current request (sent separately from historical data):' : 'Literal redaction (replace every match before transfer retention):', width),
        '', inputRow(value, width), '', ...keycaps([['Enter', 'save'], ['Esc', 'cancel']], width, color)];
      footer = [['Backspace', 'edit'], ['Ctrl+U', 'clear']];
    } else if (stage === 'workspace') {
      rows = [...wordWrap('Explicit workspace override:', width), '',
        ...(pathInput ? [inputRow(pathInput, width)] : prose('Type an absolute or relative directory path', width, 'muted', color))];
      footer = [['Enter', 'use this folder and prepare'], ['Esc', 'cancel override']];
    } else if (stage === 'summary') {
      const summary = prepared!.summary;
      const included = summary.includedItemIds, omitted = summary.omittedItemIds;
      const ids = (label: string, list: readonly string[]) => list.length ? indent(wordWrap(`${label}  ${list.join(', ')}`, inner)).map(row => styled(row, 'muted', color)) : [];
      // A long summary must remain inspectable before confirming.
      rows = [
        ...(summary.partialHistory ? [...prose(summary.partialHistory, width, 'warning', color), ''] : []),
        section('Continuation'),
        ...indent([...pair('Mode', summary.mode === 'native-resume' ? 'native resume' : 'fresh handoff', inner, color),
          ...pair('From', `${summary.source.agent}/${summary.source.nativeId}`, inner, color),
          ...pair('To', summary.target, inner, color), ...pair('Workspace', summary.workspace, inner, color)]),
        '', section('History'),
        ...indent([`Included ${included.length} of ${included.length + omitted.length} items`, `Omitted ${omitted.length}`]),
        ...ids('Included IDs', included), ...ids('Omitted IDs', omitted),
        // The exact payload keeps its escaping and stays unstyled: it is the consented wire value.
        ...(summary.previewLines?.length ? ['', styled('Exact payload', 'muted', color), ...wrap(summary.previewLines, width)] : []),
      ];
      footer = [['Enter', 'confirm continuation'], ['Esc', 'back']];
      scroll = { source: false, hint: ['↑↓', 'scroll'], at: 2 };
    } else {
      const source = picked!;
      const title = source.title.endsWith(` ${source.nativeId}`) ? `Session …${source.nativeId.slice(-8)}` : source.title;
      const chosen = targets[target]!;
      // The same rule as runtime preparation: the source's own agent resumes natively unless fresh is chosen.
      const shown = outcome?.shown;
      const selector = targets.map(agent => agent === chosen ? `[${agent}]` : agent).join('  ');
      rows = [
        section('From'),
        ...indent(wordWrap(`${source.agent}  ${title}`, inner).map((row, index) => index ? row : styled(source.agent, source.agent, color) + row.slice(source.agent.length))),
        '', section('To'),
        // Targets that do not fit on one row continue on the next; each keeps its colour.
        ...indent(wordWrap(selector, inner).map(row => row.split('  ').map(name => name === `[${chosen}]` ? styled(name, ['title', chosen], color) : styled(name, 'muted', color)).join('  '))),
        ...(!options.outcome ? [] : !shown ? indent(prose('Checking what this target will do…', inner, 'muted', color))
          : indent(prose(shown.text, inner, shown.tone, color))),
        ...indent(keycaps([['← →', 'change target']], inner, color)),
        '', section('Workspace'),
        ...indent(panelWrap(`${choice!.path}${choice!.kind === 'override' ? ' (override)' : ''}`, inner)),
        ...(options.compose ? [
          '', section('Handoff'),
          ...indent([...pair('Current request', currentRequest || '(empty)', inner, color),
            ...pair('Redactions', redactions.length ? `${redactions.length} (${redactions.map(() => '•••').join(', ')})` : 'none', inner, color),
            ...pair('Fresh context', fresh ? 'on' : 'off (automatic)', inner, color)]),
        ] : []),
      ];
      // Actions live in the footer so they stay visible on short terminals.
      footer = [['Enter', 'review'], ['Esc', 'back'], ...(options.compose ? [['C', 'edit request'], ['X', 'redact'], ['F', 'toggle fresh']] as const : []),
        ['W', 'change workspace']];
      scroll = { source: false, hint: ['↑↓', 'scroll'], at: footer.length };
    }
    if (busy && !inList && !showingSources) footer = [['', 'Loading…'], ['Esc', 'back']];
    // Key hints wrap rather than drop; their extra rows come out of the body. The scroll hint is added, and may take a
    // row of its own, only when the content is taller than the body left without it.
    const most = Math.max(1, height - header.length - status.length - 2);
    let keys = keycaps(footer, width, color);
    let bodyRows = Math.max(1, most - keys.length + 1);
    if (scroll && !busy && rows.length > bodyRows) {
      keys = keycaps([...footer.slice(0, scroll.at), scroll.hint, ...footer.slice(scroll.at)], width, color);
      bodyRows = Math.max(1, most - keys.length + 1);
    }
    pageRows = bodyRows;
    let body = rows;
    if (stage === 'list' && !showingSources) {
      body = hits.length ? sessionList(hits, selected, query.text, width, bodyRows, detailLines, color, query.workspace)
        : prose(busy ? progress : 'No matching sessions. Clear the search or change scope.', width, 'muted', color);
    } else if (scroll) {
      const top = Math.max(0, Math.min(scroll.source ? sourceOffset : offset, rows.length - bodyRows));
      if (scroll.source) sourceOffset = top; else offset = top;
      body = rows.slice(top, top + bodyRows);
    }
    const frame = [...header, ...body, '', ...keys, ...status].slice(0, height);
    output.write('\x1b[2J\x1b[H' + frame.map(line => line && ` ${line}`).join('\n'));
  };
  const redraw = (): void => {
    try {
      const predict = options.outcome;
      if (active && predict && stage === 'target' && picked && !busy) {
        const value = continuationRequest();
        const key = JSON.stringify([value.source, value.target, value.workspace, value.redactions ?? [], value.fresh ?? false, value.currentRequest === '']);
        if (outcome?.key !== key) {
          outcomeRequest?.abort();
          const controller = new AbortController();
          outcomeRequest = controller; outcome = { key };
          // Wait briefly so cycling targets does not start a read for each one passed.
          void (async () => {
            let shown: NonNullable<typeof outcome>['shown'];
            try {
              await delay(150, undefined, { signal: controller.signal });
              await usableWorkspace(value.workspace.path, controller.signal);
              const found = await predict(value, controller.signal);
              shown = { text: found.text, tone: found.native ? 'success' : [] };
            } catch (error) { shown = { text: message(error), tone: 'warning' }; }
            if (controller.signal.aborted || !active) return;
            // Kept even if another screen is open now, so returning to the target shows it.
            outcome = { key, shown };
            if (stage === 'target') redraw();
          })();
        }
      }
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
              const text = Array.from(readableRequest(item.text).replace(/\s+/gu, ' ').trim());
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
  const search = (focusId?: string): void => {
    hits = []; selected = focusId ? 0 : selected < 0 ? -1 : 0; selectionMoved = false;
    const snapshot = { ...query };
    const show = (found: readonly SessionHit[]): void => {
      const id = selectionMoved ? hits[selected]?.id : focusId;
      hits = found;
      if (id && selected >= 0) selected = Math.max(0, found.findIndex(hit => hit.id === id));
    };
    request(signal => options.query(snapshot, signal, found => {
      if (signal.aborted) return;
      show(found);
      redraw();
    }), show, () => search(focusId));
  };
  const closeSubagents = (): void => {
    const parent = parents.pop()!;
    const ancestor = parents.at(-1);
    if (ancestor) query.parentId = ancestor.id; else delete query.parentId;
    query.text = parent.search;
    search(parent.id);
  };
  const preview = (): void => {
    const source = sourceOf(picked!);
    items = []; offset = 0; expandTools = false; focusMatch = true;
    request(signal => options.preview(source, signal), found => { items = found; }, preview);
  };
  const continuationRequest = (): ContinuationRequest => ({ source: sourceOf(picked!), target: targets[target]!, workspace: { ...choice! },
    ...(options.compose ? { currentRequest, redactions: [...redactions], fresh } : {}) });
  const usableWorkspace = async (path: string, signal: AbortSignal): Promise<void> => {
    const directory = await stat(path).catch(() => undefined);
    if (!directory?.isDirectory()) throw new Error(`Workspace unavailable: ${path}. Press W to choose another folder.`);
    signal.throwIfAborted();
  };
  const prepare = (): void => {
    // Preparation decides for itself; a prediction still running would only repeat its reads.
    if (!outcome?.shown) { outcomeRequest?.abort(); outcome = undefined; }
    const requestValue = continuationRequest();
    request(async signal => {
      await usableWorkspace(requestValue.workspace.path, signal);
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
        if (stage === 'list' && parents.length) { closeSubagents(); return; }
        if (stage === 'list') { finish(); return; }
        if (stage === 'workspace' || stage === 'summary' || stage === 'request' || stage === 'redaction') { stage = 'target'; offset = 0; }
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
        if (key.name === 'f3' && !parents.length) {
          query.includeSubagents = !query.includeSubagents;
          search(hits[selected]?.id); return;
        }
        if (key.name === 'left' || key.name === 'right') {
          const hit = hits[selected];
          if (!key.shift && key.name === 'left' && parents.length) { closeSubagents(); return; }
          if (!key.shift && key.name === 'right' && hit?.subagentCount && !parents.some(parent => parent.id === hit.id)) {
            parents.push({id:hit.id,title:hit.title,search:query.text});
            query.parentId = hit.id; query.text = ''; search(); return;
          }
          if (parents.length) return;
          query.agent = filters[(filters.indexOf(query.agent) + (key.name === 'left' ? -1 : 1) + filters.length) % filters.length]!;
          search(); return;
        }
        if (key.name === 'tab' && !parents.length) { query.scope = query.scope === 'folder' ? 'global' : 'folder'; search(); return; }
        if (key.ctrl && key.name === 'u') { query.text = ''; search(); return; }
        if (key.name === 'up' || (key.name === 'down' && hits.length)) {
          selected = Math.max(-1, Math.min(hits.length - 1, selected + (key.name === 'up' ? -1 : 1)));
          selectionMoved = hits.length > 0;
        }
        else if (key.name === 'return' && selected < 0 && hits.length) { selected = 0; selectionMoved = true; }
        else if (key.name === 'return' && hits[selected]) { picked = hits[selected]; stage = 'preview'; preview(); return; }
        else if (key.name === 'backspace') { query.text = Array.from(query.text).slice(0, -1).join(''); search(); return; }
        else if (retry && key.ctrl && key.name === 'r') { retry(); return; }
        else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f-\x9f]/.test(text)) { query.text += text; search(); return; }
      } else if (stage === 'preview') {
        if (key.name === 'up') offset--;
        else if (key.name === 'down') offset++;
        else if (key.name === 'pageup') offset -= pageRows;
        else if (key.name === 'pagedown') offset += pageRows;
        else if (key.name === 't') expandTools = !expandTools;
        else if (key.name === 'return' && !busy && !retry) {
          stage = 'target'; target = 0; offset = 0; choice = { kind: 'source', path: picked!.workspace };
        }
      } else if (stage === 'target') {
        if (key.name === 'up') offset--;
        else if (key.name === 'down') offset++;
        else if (key.name === 'left' || key.name === 'right') { invalidate(); target = (target + (key.name === 'left' ? -1 : 1) + targets.length) % targets.length; offset = 0; notice = ''; }
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
