// Run by test/temp.test.mjs through scripts/test.mjs: leaves one directory behind on purpose.
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('leaks a directory', async () => { await mkdtemp(join(tmpdir(), 'agentswitch-leak-')); });
