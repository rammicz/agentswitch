import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tempDir } from './fixtures/temp.mjs';

// The demo's session list in a real PTY (#37): words stay whole in the details pane, wide terminals show whole
// titles, and an empty result lists only keys that work.
const repo = resolve('.');
async function demo(columns, rows, actions) {
  const root = await tempDir('agentswitch-demo-');
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  const env = { AGENTSWITCH_STATE_DIR: join(root, 'state'), AGENTSWITCH_NO_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' };
  const child = spawnSync('python3', ['test/fixtures/drive-integration.py'], { encoding: 'utf8', timeout: 40000,
    input: JSON.stringify({ node: process.execPath, runner: join(repo, 'test/fixtures/integration-runner.mjs'), cwd, env, actions: [...actions, { send: '\x03' }], args: ['--demo'], columns, rows }) });
  assert.equal(child.status, 0, child.stderr);
  const [{ output }] = JSON.parse(child.stdout);
  // Frames as rows without the one-cell margin.
  return output.split('\x1b[2J\x1b[H').slice(1).map(frame => frame.split(/\r?\n/).map(row => row.slice(1).trimEnd()));
}
const lastWith = (frames, text) => frames.findLast(rows => rows.some(row => row.includes(text)));
const excerpts = ['Opening request: Build a quiet session picker with keyboard navigation.', 'Reply: Search and arrow-key navigation are the next steps.',
  'Opening request: Preserve constraints and show omitted history during transfer.'];
const words = new Set(excerpts.join(' ').split(' '));
// Every row of a wrapped excerpt holds whole words.
function assertWholeWords(rows) {
  const start = rows.findIndex(row => row.includes('Opening request:'));
  assert.ok(start >= 0, JSON.stringify(rows));
  for (const row of rows.slice(start)) {
    const text = row.includes('│ ') ? row.slice(row.indexOf('│ ') + 2) : row;
    if (!text || text.startsWith('↑↓')) break;
    for (const word of text.split(' ')) assert.ok(words.has(word), `"${word}" is cut in ${JSON.stringify(text)}`);
  }
}

for (const [columns, rows] of [[80, 24], [100, 30]]) {
  test(`#37 demo list at ${columns} columns shows whole titles and wraps excerpts between words`, async () => {
    const frames = await demo(columns, rows, [{ wait: 'Opening request: Build' }, { send: '\x1b[B' }, { wait: 'Opening request: Preserve' }]);
    for (const [marker, title] of [['Build', 'Finish the session picker'], ['Preserve', 'Investigate context handoff']]) {
      const screen = lastWith(frames, `Opening request: ${marker}`);
      assert.ok(screen.some(row => /^. (codex|claude) +Finish the session picker +4d ago/.test(row)), JSON.stringify(screen));
      assert.ok(screen.some(row => /^. claude Investigate context handoff +5d ago/.test(row)), JSON.stringify(screen));
      assert.ok(screen.some(row => row.endsWith(title)), 'the details title');
      assertWholeWords(screen);
      for (const row of screen) assert.ok(Array.from(row).length <= columns - 2, JSON.stringify(row));
      const divider = screen.find(row => row.includes(' │ '));
      // Side by side, the details pane keeps at least 40 cells.
      if (divider) assert.ok(columns - 2 - (Array.from(divider).indexOf('│') + 2) >= 40, divider);
    }
  });
  test(`#37 an empty result at ${columns} columns offers only keys that work`, async () => {
    const frames = await demo(columns, rows, [{ wait: 'Enter preview' }, { send: 'zzz' }, { wait: 'Search: zzz' }, { wait: 'No matching sessions' }]);
    const screen = lastWith(frames, 'No matching sessions');
    const footer = screen.find(row => row.endsWith('Esc quit'));
    assert.equal(footer, 'Ctrl+U clear search  Esc quit', JSON.stringify(screen));
    assert.ok(!screen.some(row => /Enter preview|↑↓ select/.test(row)), JSON.stringify(screen));
  });
}
