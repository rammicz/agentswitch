// Run by test/temp.test.mjs through scripts/test.mjs: uses the helper and leaves nothing behind.
import test from 'node:test';
import { tempDir } from '../temp.mjs';
test('uses the helper', async () => { await tempDir('agentswitch-clean-'); });
