import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tempDir } from './fixtures/temp.mjs';
import { scaled } from './fixtures/timeouts.mjs';

// The demo's session list in a real PTY (#37): words stay whole in the details pane, wide terminals show whole
// titles, and an empty result lists only keys that work.
const repo = resolve('.');
const timeout = scaled(120_000);
async function demo(columns, rows, actions) {
  const root = await tempDir('agentswitch-demo-');
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  const env = { AGENTSWITCH_STATE_DIR: join(root, 'state'), AGENTSWITCH_NO_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' };
  const child = spawnSync('python3', ['test/fixtures/drive-integration.py'], { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
    input: JSON.stringify({ node: process.execPath, runner: join(repo, 'test/fixtures/integration-runner.mjs'), cwd, env, actions: [...actions, { send: '\x03' }], args: ['--demo'], columns, rows }) });
  if (child.error) throw new Error(`PTY driver failed: ${child.error.message}\n${child.stderr?.slice(-4096) ?? ''}`, { cause: child.error });
  assert.equal(child.status, 0, child.stderr);
  const [{ output }] = JSON.parse(child.stdout);
  // Frames as rows without the one-cell margin and the terminal modes set on exit.
  return output.split('\x1b[2J\x1b[H').slice(1).map(frame => frame.split(/\r?\n/).map(row => row.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '').slice(1).trimEnd()));
}
const lastWith = (frames, text) => frames.findLast(rows => rows.some(row => row.includes(text)));
// The details text from the excerpt to the end of the pane, its rows joined by spaces: a word cut across rows breaks it.
function excerptText(rows) {
  const start = rows.findIndex(row => row.includes('Opening request:'));
  assert.ok(start >= 0, JSON.stringify(rows));
  const pane = rows.slice(start).map(row => row.includes('│ ') ? row.slice(row.indexOf('│ ') + 2) : row);
  return pane.slice(0, pane.findIndex(text => !text || text.startsWith('↑↓'))).join(' ');
}

const noRowWider = (frames, columns) => { for (const row of frames.flat()) assert.ok(Array.from(row).length <= columns - 2, JSON.stringify(row)); };

for (const [columns, rows] of [[40, 24], [80, 24], [100, 30]]) {
  test(`#37 demo at ${columns} columns: whole titles, whole words, working and visible keys, one session ID, other folders marked`, async () => {
    const frames = await demo(columns, rows, [{ wait: 'Opening request: Build' }, { send: '\x1b[B' }, { wait: 'Opening request: Preserve' },
      { send: 'zzz' }, { wait: 'Search: zzz' }, { wait: 'No matching sessions' },
      { send: '\x15\t' }, { wait: 'Scope: global' }, { wait: 'Fix Unicod' }, { wait: 'Enter preview' },
      { send: '\r' }, { wait: 'Enter choose target' }, { send: '\r' }, { wait: 'Enter review' }, { send: '\r' }, { wait: 'Enter confirm continuation' }]);
    noRowWider(frames, columns);
    for (const [title, excerpt] of [['Finish the session picker', 'Opening request: Build a quiet session picker with keyboard navigation.'],
      ['Investigate context handoff', 'Opening request: Preserve constraints and show omitted history during transfer.']]) {
      const screen = lastWith(frames, excerpt.slice(0, 22));
      // The scope stays in view at every width.
      assert.ok(screen.some(row => row.includes('Tab Scope: folder')), JSON.stringify(screen));
      if (columns >= 80) {
        assert.ok(screen.some(row => /^. codex  Finish the session picker +4d ago/.test(row)), JSON.stringify(screen));
        assert.ok(screen.some(row => /^. claude Investigate context handoff +5d ago/.test(row)), JSON.stringify(screen));
      }
      assert.ok(screen.some(row => row.endsWith(title)), 'the details title');
      assert.ok(excerptText(screen).startsWith(excerpt), JSON.stringify(screen));
      const divider = screen.find(row => row.includes(' │ '));
      // Side by side, the details pane keeps at least 40 cells.
      if (divider) assert.ok(columns - 2 - (Array.from(divider).indexOf('│') + 2) >= 40, divider);
    }
    const empty = lastWith(frames, 'No matching sessions');
    assert.equal(empty.find(row => row.endsWith('Esc quit')), 'Ctrl+U clear search  Esc quit', JSON.stringify(empty));
    assert.ok(!empty.some(row => /Enter preview|↑↓ select/.test(row)), JSON.stringify(empty));
    // Global scope: only the result from another folder names that folder in its row.
    const global = lastWith(frames, 'Fix Unicod');
    assert.ok(global.some(row => row.includes('Tab Scope: global')), JSON.stringify(global));
    assert.match(global.find(row => row.includes('Fix Unicod')), /Fix Unicod.* another/u, JSON.stringify(global));
    assert.ok(global.filter(row => /^. (codex|claude) /u.test(row) && row.includes('another')).length === 1, JSON.stringify(global));
    // Short screens offer no scrolling.
    const preview = lastWith(frames, 'Enter choose target');
    assert.ok(!preview.some(row => row.includes('scroll')), JSON.stringify(preview));
    const target = lastWith(frames, 'Enter review');
    for (const key of ['Enter review', 'Esc back', 'W change workspace']) assert.ok(target.some(row => row.includes(key)), `${key}: ${JSON.stringify(target)}`);
    const summary = lastWith(frames, 'Enter confirm continuation');
    assert.ok(summary.includes('  From  codex/demo-codex'), JSON.stringify(summary));
    assert.ok(!summary.some(row => row.includes('scroll') || row.includes('(demo-codex)')), JSON.stringify(summary));
  });
}
