import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './fixtures/temp.mjs';

const run = (...args) => spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' });

test('plain invocation requires a terminal without reading native histories', () => {
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /interactive terminal/);
});

test('CLI handles version, invalid flags and noninteractive demo explicitly', () => {
  const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(run('--version').stdout.trim(), metadata.version);
  assert.equal(run('--unknown').status, 1);
  const demo = run('--demo');
  assert.equal(demo.status, 1);
  assert.match(demo.stderr, /interactive terminal/);
  assert.equal(run('--global').status, 1);
});

test('relocated CLI reports its adjacent release metadata', async () => {
  const directory = await tempDir('agentswitch-version-');
  cpSync('dist', join(directory, 'dist'), { recursive: true });
  const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
  metadata.version = '0.1.0-dev.metadata-check';
  writeFileSync(join(directory, 'package.json'), JSON.stringify(metadata));
  const result = spawnSync(process.execPath, [join(directory, 'dist/cli.js'), '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), metadata.version);
});
