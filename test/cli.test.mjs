import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const run = (...args) => spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' });

test('plain invocation requires a terminal without reading native histories', () => {
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /interactive terminal/);
});

test('CLI handles version, invalid flags and noninteractive demo explicitly', () => {
  assert.equal(run('--version').stdout.trim(), '0.1.0-dev.0');
  assert.equal(run('--unknown').status, 1);
  const demo = run('--demo');
  assert.equal(demo.status, 1);
  assert.match(demo.stderr, /interactive terminal/);
  assert.equal(run('--global').status, 1);
});
