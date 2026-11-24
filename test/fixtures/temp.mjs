// Temporary directories for tests. Every directory is removed even when its test fails, so a test run leaves
// nothing behind in its temp root (scripts/test.mjs checks that).
import { after, afterEach } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Retries give Windows time to release handles that a just-closed process or database still holds.
const remove = paths => Promise.all(paths.map(path => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const testDirectories = [], fileDirectories = [];
// A hook added here runs after the test's own t.after hooks, so databases they close are closed before removal.
afterEach(t => { const paths = testDirectories.splice(0); if (paths.length) t.after(() => remove(paths)); });
after(() => remove(fileDirectories));
const create = (list, prefix) => { const path = mkdtempSync(join(tmpdir(), prefix)); list.push(path); return path; };

/** A fresh directory under the temp root, removed after the test that is running. Use fileTempDir outside tests. */
export const tempDir = prefix => create(testDirectories, prefix);

/** A directory shared by every test in the file, removed after the last one. */
export const fileTempDir = prefix => create(fileDirectories, prefix);
