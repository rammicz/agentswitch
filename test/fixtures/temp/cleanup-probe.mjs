// Run by test/temp.test.mjs in its own temp root: one test fails on purpose after creating a directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { fileTempDir, tempDir } from '../temp.mjs';
const shared = fileTempDir('agentswitch-probe-file-');
let failed;
test('fails after creating a directory', async () => { failed = await tempDir('agentswitch-probe-failed-'); throw new Error('expected failure'); });
test('the failed test directory is already gone and the shared one remains', async () => {
  await assert.rejects(access(failed)); await access(shared); await tempDir('agentswitch-probe-passed-');
});
