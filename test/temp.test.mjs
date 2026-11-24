import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { tempDir } from './fixtures/temp.mjs';

// A nested runner must not inherit this process's test-runner context, or it reports to it instead of exiting.
const run = (root, args) => {
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  return spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...env, TMPDIR: root, TMP: root, TEMP: root } });
};

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
  const clean = run(root, ['scripts/test.mjs', 'test/fixtures/temp/clean.mjs']);
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(await readdir(root), []);
});
