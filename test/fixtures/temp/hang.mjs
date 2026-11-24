// Run by test/temp.test.mjs through scripts/test.mjs: starts a child process, reports its PID and waits until stopped.
// With HANG_LOCK it also leaves a directory that cannot be removed until the test unlocks it.
import test from 'node:test';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../temp.mjs';
test('waits until the run is interrupted', async () => {
  const directory = tempDir('agentswitch-hang-');
  if (process.env.HANG_LOCK) { mkdirSync(join(directory, 'locked')); writeFileSync(join(directory, 'locked', 'file'), ''); chmodSync(join(directory, 'locked'), 0o500); }
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.env.HANG_READY + '.partial', String(child.pid));
  renameSync(process.env.HANG_READY + '.partial', process.env.HANG_READY);
  await new Promise(() => {});
});
