// Runs the test suite in a dedicated temp root and fails when the run leaves agentswitch directories behind.
// Usage: node scripts/test.mjs [node --test options] [test files]; without .mjs files, every test/*.test.mjs runs.
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const files = args.some(arg => arg.endsWith('.mjs')) ? [] : ['test/*.test.mjs'];
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// Retries cover a process that is still releasing or writing its directory; a root that stays is left to the
// next run's sweep instead of failing this run.
const remove = path => {
  try { rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); return true; } catch { return false; }
};

// A run root carries its runner's PID. Roots whose runner no longer exists were left by a killed run; other
// agentswitch directories and the roots of live runs are never touched.
for (const name of readdirSync(tmpdir())) {
  const owner = /^agentswitch-test-run-(\d+)-[A-Za-z0-9]{6}$/.exec(name)?.[1];
  if (owner && !alive(Number(owner))) remove(join(tmpdir(), name));
}
const root = mkdtempSync(join(tmpdir(), `agentswitch-test-run-${process.pid}-`));
// On POSIX the tests get their own process group, so an interrupt reaches every test process.
const group = process.platform !== 'win32';
let interrupted, status = 1;
try {
  const run = spawn(process.execPath, ['--test', ...args, ...files], {
    stdio: 'inherit', detached: group, env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
  });
  const signalTests = signal => { try { if (group) process.kill(-run.pid, signal); else run.kill(signal); } catch {} };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = signal; signalTests(signal); });
  status = await new Promise((resolve, reject) => run.on('error', reject).on('close', code => resolve(code ?? 1)));
  // Test processes such as the PTY drivers may outlive the runner's child while they stop the sessions they
  // created. Wait for them, and kill whatever is still left after that.
  if (group) {
    for (let waited = 0; alive(-run.pid) && waited < 10_000; waited += 50) {
      if (waited === 5_000) signalTests('SIGKILL');
      await delay(50);
    }
  }
  const left = readdirSync(root).filter(name => name.startsWith('agentswitch'));
  if (left.length && !interrupted) {
    const prefixes = new Map();
    for (const name of left) { const prefix = name.slice(0, -6); prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1); }
    console.error(`Test run left ${left.length} temporary director${left.length === 1 ? 'y' : 'ies'}: ` +
      [...prefixes].map(([prefix, count]) => `${JSON.stringify(prefix)} x${count}`).join(', '));
    status ||= 1;
  }
} catch (error) {
  console.error(`Test run failed to start: ${error.message}`);
} finally {
  if (!remove(root)) console.error(`Could not remove ${root}; the next test run removes it.`);
}
process.exit(interrupted ? 128 + constants.signals[interrupted] : status);
