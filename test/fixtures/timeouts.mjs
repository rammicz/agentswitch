// Bounds for test steps that wait on child processes, scaled like the PTY drivers' waits (test/fixtures/pty_wait.py).
const value = Number(process.env.AGENTSWITCH_TEST_TIMEOUT_SCALE || 1);
if (!Number.isFinite(value) || value <= 0) throw new Error('AGENTSWITCH_TEST_TIMEOUT_SCALE must be a positive number');

/** A bound in milliseconds, scaled for this machine. It only limits a real hang; a healthy step ends sooner. */
export const scaled = (ms) => ms * value;
