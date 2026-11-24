// Temporary directories for tests. Every directory is removed even when its test fails, so a test run leaves
// nothing behind in its temp root (scripts/test.mjs checks that).
import { after, afterEach } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Retries give Windows time to release handles that a just-closed process or database still holds.
const remove = paths => Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const testDirectories = [], fileDirectories = [];
// A hook added here runs after the test's own t.after hooks, so databases they close are closed before removal.
afterEach(t => { const paths = testDirectories.splice(0); if (paths.length) t.after(() => remove(paths)); });
after(() => remove(fileDirectories));

/** A fresh directory under the temp root, removed after the current test. */
export async function tempDir(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  testDirectories.push(path);
  return path;
}

/** A directory shared by every test in the file, removed after the last one. */
export function fileTempDir(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  fileDirectories.push(path);
  return path;
}
