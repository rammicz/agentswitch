// Run by test/temp.test.mjs through scripts/test.mjs: starts a child process, reports its PID and waits until stopped.
import test from 'node:test';
import { spawn } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { tempDir } from '../temp.mjs';
test('waits until the run is interrupted', async () => {
  tempDir('agentswitch-hang-');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.env.HANG_READY + '.partial', String(child.pid));
  renameSync(process.env.HANG_READY + '.partial', process.env.HANG_READY);
  await new Promise(() => {});
});
