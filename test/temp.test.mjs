import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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

test('an interrupted run stops its test processes and removes its temp root', { skip: process.platform === 'win32' && 'POSIX signals', timeout: 60_000 }, async () => {
  const root = tempDir('agentswitch-temp-signal-'), ready = join(tempDir('agentswitch-temp-ready-'), 'pid');
  const runner = spawn(process.execPath, ['scripts/test.mjs', 'test/fixtures/temp/hang.mjs'], { stdio: 'ignore', env: environment(root, { HANG_READY: ready }) });
  const exited = new Promise(resolve => runner.on('exit', (code, signal) => resolve({ code, signal })));
  while (!existsSync(ready)) await delay(50);
  const grandchild = Number(readFileSync(ready, 'utf8'));
  runner.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 143, signal: null });
  assert.deepEqual(await readdir(root), []);
  for (let i = 0; i < 100 && alive(grandchild); i++) await delay(50);
  assert.equal(alive(grandchild), false, 'the test process tree is stopped');
});

test('a run removes run roots left by runners that no longer exist, and nothing else', async () => {
  const root = tempDir('agentswitch-temp-stale-');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  const kept = [`agentswitch-test-run-${process.pid}-AbC123`, 'agentswitch-test-run-AbC123', `agentswitch-other-${dead}-AbC123`, `agentswitch-test-run-${dead}-AbC123-extra`];
  for (const name of [`agentswitch-test-run-${dead}-AbC123`, ...kept]) mkdirSync(join(root, name));
  run(root, ['scripts/test.mjs', 'test/fixtures/temp/leak.mjs']);
  assert.deepEqual((await readdir(root)).sort(), kept.sort());
});
