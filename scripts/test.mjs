// Runs the test suite in a dedicated temp root and fails when the run leaves agentswitch directories behind.
// Usage: node scripts/test.mjs [node --test options] [test files]; without files, every test/*.test.mjs runs.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const files = args.some(arg => !arg.startsWith('-')) ? [] :
  readdirSync('test').filter(name => name.endsWith('.test.mjs')).sort().map(name => join('test', name));
// Only this run's own root is inspected and removed, so concurrent runs and other sessions are not affected.
const root = mkdtempSync(join(tmpdir(), 'agentswitch-test-run-'));
let status = 1;
try {
  const run = spawnSync(process.execPath, ['--test', ...args, ...files], {
    stdio: 'inherit', env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
  });
  status = run.status ?? 1;
  const left = readdirSync(root).filter(name => name.startsWith('agentswitch'));
  if (left.length) {
    const prefixes = new Map();
    for (const name of left) { const prefix = name.slice(0, -6); prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1); }
    console.error(`Test run left ${left.length} temporary director${left.length === 1 ? 'y' : 'ies'}: ` +
      [...prefixes].map(([prefix, count]) => `${JSON.stringify(prefix)} x${count}`).join(', '));
    status ||= 1;
  }
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exit(status);
