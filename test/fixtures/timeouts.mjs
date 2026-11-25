// Bounds for test steps that wait on child processes, scaled like the PTY drivers' waits (test/fixtures/pty_wait.py).
import assert from 'node:assert/strict';
const value = Number(process.env.AGENTSWITCH_TEST_TIMEOUT_SCALE || 1);
if (!Number.isFinite(value) || value <= 0) throw new Error('AGENTSWITCH_TEST_TIMEOUT_SCALE must be a positive number');

/** A bound in milliseconds, scaled for this machine. It only limits a real hang; a healthy step ends sooner. */
export const scaled = (ms) => ms * value;

/** Check a driver run whose marker never appeared: it failed at the marker's bound and showed the last screen as text. */
export function assertMissing(result, marker, seconds, visible) {
  assert.notEqual(result.status, 0, 'the driver fails');
  const bound = String(scaled(seconds * 1000) / 1000).replace('.', '\\.');
  assert.match(result.stderr, new RegExp(`Missing '${marker}' within ${bound}s; last screen:\n`));
  const screen = result.stderr.slice(result.stderr.indexOf('last screen:'));
  assert.match(screen, visible);
  assert.doesNotMatch(screen, /\x1b/);
}
