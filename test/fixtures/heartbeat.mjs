// Stops a fake provider child that a crash test kept alive on purpose (CLI_CHILD_HEARTBEAT).
import { readFileSync, statSync } from 'node:fs';

/** Kills the heartbeat's writer if the heartbeat is still advancing, so a recycled PID is never signalled. */
export function stopHeartbeatChild(path) {
  try {
    const { pid } = JSON.parse(readFileSync(path, 'utf8'));
    if (Date.now() - statSync(path).mtimeMs < 1000) process.kill(pid, 'SIGKILL');
  } catch {}
}
