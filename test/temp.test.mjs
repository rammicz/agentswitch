import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tempDir } from './fixtures/temp.mjs';

// A nested runner must not inherit this process's test-runner context, or it reports to it instead of exiting.
const environment = (root, extra = {}) => {
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  return { ...env, TMPDIR: root, TMP: root, TEMP: root, ...extra };
};
const run = (root, args) => spawnSync(process.execPath, args, { encoding: 'utf8', env: environment(root) });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('test temp directories are removed after each test, also when the test fails', async () => {
  const root = await tempDir('agentswitch-temp-helper-');
  const probe = run(root, ['--test', 'test/fixtures/temp/cleanup-probe.mjs']);
  assert.notEqual(probe.status, 0, 'the probe has one failing test');
  assert.match(probe.stdout, /# pass 1/);
  assert.deepEqual(await readdir(root), []);
});

test('the test runner fails when a run leaves agentswitch directories and removes its own temp root', async () => {
  const root = await tempDir('agentswitch-temp-guard-');
  const leak = run(root, ['scripts/test.mjs', 'test/fixtures/temp/leak.mjs']);
  assert.equal(leak.status, 1);
  assert.match(leak.stderr, /left 1 temporary directory: "agentswitch-leak-" x1/);
  assert.deepEqual(await readdir(root), []);
});

const posix = { skip: process.platform === 'win32' && 'POSIX signals', timeout: 120_000 };
// Starts the runner, waits until `ready()` returns a PID, interrupts the run and reports how it ended.
async function interrupt(root, args, extra, ready, signal = 'SIGTERM') {
  let stderr = '';
  const runner = spawn(process.execPath, ['scripts/test.mjs', ...args], { stdio: ['ignore', 'ignore', 'pipe'], env: environment(root, extra) });
  runner.stderr.on('data', data => { stderr += data; });
  const exited = new Promise(resolve => runner.on('close', (code, signal) => resolve({ code, signal })));
  let pid;
  while (!(pid = ready())) await delay(20);
  runner.kill(signal);
  return { ...await exited, stderr, pid };
}
const stopped = async pid => { for (let i = 0; i < 100 && alive(pid); i++) await delay(50); return !alive(pid); };

test('an interrupted run stops its test processes and removes its temp root', posix, async () => {
  const root = tempDir('agentswitch-temp-signal-'), ready = join(tempDir('agentswitch-temp-ready-'), 'pid');
  const run = await interrupt(root, ['test/fixtures/temp/hang.mjs'], { HANG_READY: ready }, () => existsSync(ready) && Number(readFileSync(ready, 'utf8')));
  assert.deepEqual([run.code, run.signal], [143, null]);
  assert.deepEqual(await readdir(root), []);
  assert.equal(await stopped(run.pid), true, 'the test process tree is stopped');
});

test('an interrupted PTY crash test leaves no live provider child and no temp root', posix, async () => {
  const root = tempDir('agentswitch-temp-pty-');
  // The fake provider writes its heartbeat into the crash test's directory under the run root.
  const heartbeat = () => {
    try {
      for (const run of readdirSync(root)) for (const entry of readdirSync(join(root, run))) {
        try { return JSON.parse(readFileSync(join(root, run, entry, 'child-heartbeat'), 'utf8')).pid; } catch {}
      }
    } catch {}
  };
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const run = await interrupt(root, ['--test-name-pattern', 'wrapper death after READY \\(committed-first\\)', 'test/integration.test.mjs'], {}, heartbeat, signal);
    assert.deepEqual([run.code, run.signal], [128 + constants.signals[signal], null], run.stderr);
    assert.equal(await stopped(run.pid), true, 'the provider child is stopped');
    assert.deepEqual(await readdir(root), []);
  }
});

test('a run root that cannot be removed is left to the next run without failing the interrupted run', { ...posix, skip: posix.skip || (process.getuid?.() === 0 && 'root ignores permissions') }, async () => {
  const root = tempDir('agentswitch-temp-locked-'), ready = join(tempDir('agentswitch-temp-ready-'), 'pid');
  const result = await interrupt(root, ['test/fixtures/temp/hang.mjs'], { HANG_READY: ready, HANG_LOCK: '1' }, () => existsSync(ready) && Number(readFileSync(ready, 'utf8')));
  assert.deepEqual([result.code, result.signal], [143, null]);
  assert.match(result.stderr, /Could not remove .*agentswitch-test-run-\d+-\w{6}; the next test run removes it\./);
  assert.equal(await stopped(result.pid), true, 'the test process tree is stopped');
  const [left] = await readdir(root);
  for (const directory of readdirSync(join(root, left))) chmodSync(join(root, left, directory, 'locked'), 0o700);
  run(root, ['scripts/test.mjs', 'test/fixtures/temp/leak.mjs']);
  assert.deepEqual(await readdir(root), []);
});

test('a run removes run roots left by runners that no longer exist, and nothing else', async () => {
  const root = tempDir('agentswitch-temp-stale-');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  const kept = [`agentswitch-test-run-${process.pid}-AbC123`, 'agentswitch-test-run-AbC123', `agentswitch-other-${dead}-AbC123`, `agentswitch-test-run-${dead}-AbC123-extra`];
  for (const name of [`agentswitch-test-run-${dead}-AbC123`, ...kept]) mkdirSync(join(root, name));
  run(root, ['scripts/test.mjs', 'test/fixtures/temp/leak.mjs']);
  assert.deepEqual((await readdir(root)).sort(), kept.sort());
});
