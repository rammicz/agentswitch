import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import type { AgentId, Scope, Session, SessionQuery } from '../domain.js';
import { searchSessions } from '../search.js';

/** A deliberately small interaction prototype. It never launches a provider. */
export async function runDemo(sessions: readonly Session[], workspace: string, scope: Scope = 'folder'): Promise<void> {
  const filters = ['all', 'codex', 'claude'] as const;
  const targets: readonly AgentId[] = ['codex', 'claude'];
  const query: SessionQuery = { text: '', agent: 'all', scope, workspace };
  let selected = 0;
  let target = 0;
  let picking: Session | undefined;
  let notice = '';
  const clean = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  const draw = (): void => {
    const rows = Math.max(1, (process.stdout.rows || 24) - 10);
    const width = Math.max(1, (process.stdout.columns || 80) - 1);
    const found = searchSessions(sessions, query);
    selected = Math.max(0, Math.min(selected, found.length - 1));
    const start = Math.max(0, selected - rows + 1);
    const lines = [
      'agentswitch  /  DEMO — synthetic sessions',
      '',
      `Search: ${query.text || 'type to search history…'}`,
      `← → Agent: ${query.agent}     Tab Scope: ${query.scope}`,
      '',
      ...found.slice(start, start + rows).map((s, i) => `${start + i === selected ? '›' : ' '} ${s.agent.padEnd(6)} ${s.title}`),
      ...(found.length ? [] : ['No matching sessions. Clear the search or change scope.']),
      '',
      picking ? `Continue “${picking.title}” with: ← ${targets[target]} →  Enter confirm · Esc back` : '↑ ↓ Select · Enter choose target · Esc quit',
      notice,
    ];
    process.stdout.write('\x1b[2J\x1b[H' + lines.map((line) => clean(line).slice(0, width)).join('\n'));
  };
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  await new Promise<void>((done) => {
    const finish = (): void => {
      process.stdin.removeListener('keypress', onKey);
      process.removeListener('SIGTERM', finish);
      process.removeListener('SIGINT', finish);
      process.stdout.removeListener('resize', draw);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write('\x1b[?25h\x1b[?1049l');
      done();
    };
    const onKey = (text: string | undefined, key: Key): void => {
      if (key.ctrl && key.name === 'c') { finish(); return; }
      if (key.name === 'escape') {
        if (picking) picking = undefined;
        else { finish(); return; }
      } else if (picking) {
        if (key.name === 'left' || key.name === 'right') target = (target + 1) % targets.length;
        if (key.name === 'return') {
          notice = `Demo only: ${picking.agent} → ${targets[target]}. No agent launched; handoff is planned.`;
          picking = undefined;
        }
      } else if (key.name === 'left' || key.name === 'right') {
        const delta = key.name === 'left' ? -1 : 1;
        query.agent = filters[(filters.indexOf(query.agent) + delta + filters.length) % filters.length]!;
        selected = 0;
      } else if (key.name === 'tab') {
        query.scope = query.scope === 'folder' ? 'global' : 'folder'; selected = 0;
      } else if (key.name === 'up') selected = Math.max(0, selected - 1);
      else if (key.name === 'down') selected++;
      else if (key.name === 'return') { picking = searchSessions(sessions, query)[selected]; target = 0; }
      else if (key.name === 'backspace') { query.text = Array.from(query.text).slice(0, -1).join(''); selected = 0; }
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f-\x9f]/.test(text)) { query.text += text; selected = 0; }
      draw();
    };
    process.stdin.on('keypress', onKey);
    process.on('SIGTERM', finish);
    process.on('SIGINT', finish);
    process.stdout.on('resize', draw);
    draw();
  });
}
