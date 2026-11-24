import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { agentCatalog } from './adapters/index.js';
import { openCodeNativeId } from './adapters/opencode.js';
import { windowsConsoleMode, windowsNpmEntry } from './windows-runtime.js';
import type { AgentId } from './domain.js';
import type { ContinuationRequest, PreparedContinuation, SessionSource } from './tui/contracts.js';

/** Conservative transport limit, not a model context window or an OS argv guarantee. */
export const MAX_INITIAL_PROMPT_BYTES = 16 * 1024;
export class RuntimeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'RuntimeError'; }
}
export interface RuntimeSource extends SessionSource {
  workspace: string;
  /** Supplied by the trusted adapter/catalog, never by the picker choice. */
  nativeResume: 'compatible' | 'incompatible' | 'unknown';
}
/** #8 supplies the complete serialized user prompt, including the distinct current request. */
export interface PreparedPrompt {
  prompt: string;
  includedItemIds: readonly string[];
  omittedItemIds: readonly string[];
}
export interface RuntimeInput {
  mode?: 'auto' | 'fresh';
  handoff?: PreparedPrompt;
  /** Ordinary source-native resume receives only this new request. */
  currentRequest?: string;
  /** Trusted continuity resolution. This identity is independent from selected history. */
  resumeTarget?:RuntimeSource;
  observerCommand?:string;
  requireReceipt?:boolean;
}
export interface OwnedSessionGuard {
  check(source: SessionSource): 'idle' | 'active' | 'unknown';
  /** Must acquire atomically or throw. Release only this acquisition. */
  acquire(source: SessionSource): () => void;
}
/** Detects this runtime's writers only; not arbitrary external native clients. */
export function createOwnedSessionGuard(): OwnedSessionGuard {
  const owned = new Set<string>();
  const key = (source: SessionSource) => JSON.stringify([source.agent, source.nativeId]);
  return {
    check: source => owned.has(key(source)) ? 'active' : 'idle',
    acquire(source) {
      const id = key(source);
      if (owned.has(id)) throw new RuntimeError('ACTIVE_SESSION', 'Native session is active in this runtime. Stop its owner or explicitly choose a fresh handoff.');
      owned.add(id);
      let released = false;
      return () => { if (!released) { released = true; owned.delete(id); } };
    },
  };
}
const processOwnedSessionGuard = createOwnedSessionGuard();
let terminalOwned = false;

export interface RuntimeOptions {
  executables?: Partial<Record<AgentId, string>>;
  /** Defaults to native inherited environment. Values are never included in diagnostics. */
  env?: NodeJS.ProcessEnv;
  getSource(source: SessionSource, signal?: AbortSignal): Promise<RuntimeSource>;
  guard?: OwnedSessionGuard;
  promptByteLimit?: number;
  probeTimeoutMs?: number;
}
export interface LaunchPlan {
  readonly mode: 'native-resume' | 'fresh-handoff';
  readonly target: AgentId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly workspace: string;
  readonly version: string;
  readonly nativeTarget:SessionSource|null;
  readonly observer:'codex-hooks'|'none';
}
export interface LaunchResult {
  launched: true;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Process exit is not an acknowledgment of history consumption. */
  consumption: 'unknown';
  recovery?: string;
}
interface Snapshot {
  source: SessionSource;
  workspacePath: string;
  workspaceIdentity: string;
  executableIdentity: string;
  used: boolean;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (code: string, message: string): never => { throw new RuntimeError(code, message); };
/** Agents whose native open of an existing session takes no initial request. */
export const opensWithoutRequest = (agent: string): boolean => ['opencode', 'agy', 'grok'].includes(agent);
/**
 * Why a native open of an existing session is refused, if it is: it needs the recorded workspace and no initial request.
 * Preparation enforces it; the picker's outcome states it in advance.
 */
export function nativeOpenRefusal(recordedWorkspace: boolean, currentRequest: string | undefined): RuntimeError | undefined {
  if (!recordedWorkspace) return new RuntimeError('WORKSPACE_CHOICE', 'Native resume requires its recorded workspace. Select F for a reviewed fresh context.');
  if (currentRequest !== '') return new RuntimeError('NATIVE_REQUEST_UNSUPPORTED', 'Native resume opens without an initial request. Clear the request explicitly, or select F to preserve the draft in a reviewed fresh context.');
  return undefined;
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail('CANCELLED', 'Continuation cancelled before launch.');
}
async function directory(path: string): Promise<{ path: string; identity: string }> {
  try {
    if (!isAbsolute(path) || path.includes('\0')) throw Error();
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (!info.isDirectory()) throw Error();
    await access(canonical, constants.R_OK | constants.X_OK);
    return { path: canonical, identity: `${info.dev}:${info.ino}` };
  } catch { return fail('WORKSPACE_UNAVAILABLE', 'Workspace is unavailable or inaccessible. Restore it or explicitly choose a valid override.'); }
}
async function executableIdentity(path: string): Promise<string> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw Error();
    await access(path, constants.X_OK);
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch { return fail('EXECUTABLE_UNAVAILABLE', 'Target executable is unavailable or not executable. Install the target independently and prepare again.'); }
}
async function resolveExecutable(command: string, env: NodeJS.ProcessEnv, agent: AgentId): Promise<string> {
  if (command.includes('\0')) return fail('EXECUTABLE_UNAVAILABLE', 'Invalid target executable.');
  const windows = process.platform === 'win32';
  const path = windows ? Object.entries(env).find(([name]) => name.toLowerCase() === 'path')?.[1] : env.PATH;
  const commands = windows && !/\.(?:exe|cmd|[cm]?js)$/i.test(command) ? [command + '.exe', command + '.cmd'] : [command];
  const candidates = isAbsolute(command) ? commands : /[\\/]/.test(command) ? [] :
    (path ?? '').split(delimiter).filter(isAbsolute).flatMap(directory => commands.map(name => join(directory, name)));
  for (const candidate of candidates) {
    try {
      const path = windows && /\.cmd$/i.test(candidate) ? await windowsNpmEntry(candidate, agent) : await realpath(candidate);
      if (!path) continue;
      await executableIdentity(path);
      return path;
    } catch { /* Try the next PATH entry. */ }
  }
  return fail('EXECUTABLE_UNAVAILABLE', 'Target executable was not found or is not executable. Install it independently and prepare again.');
}
function invocation(executable: string, args: readonly string[]): [string, string[]] {
  return process.platform === 'win32' && !/\.exe$/i.test(executable)
    ? [process.execPath, [executable, ...args]] : [executable, [...args]];
}
/** Only --version/--help are permitted probes; bound time and combined output. */
function probe(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number, signal?: AbortSignal): Promise<string> {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const [program, argv] = invocation(executable, args);
    const child = spawn(program, argv, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let bytes = 0; let failure: RuntimeError | undefined;
    const stop = (error: RuntimeError) => { failure ??= error; child.kill('SIGKILL'); };
    const abort = () => stop(new RuntimeError('CANCELLED', 'Capability preparation cancelled.'));
    const timer = setTimeout(() => stop(new RuntimeError('CAPABILITY_TIMEOUT', 'Target capability probe timed out. Check the executable and prepare again.')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) stop(new RuntimeError('CAPABILITY_OUTPUT', 'Target capability output exceeds the supported limit.'));
      else output += chunk.toString('utf8');
    });
    child.on('error', () => { failure ??= new RuntimeError('EXECUTABLE_UNAVAILABLE', 'Cannot run target executable. Check installation and permissions, then prepare again.'); });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0 || exitSignal) reject(new RuntimeError('CAPABILITY_FAILED', 'Target capability probe failed. Check the executable and prepare again.'));
      else resolve(output.trim());
    });
    if (signal?.aborted) abort();
  });
}
interface LaunchValues { workspace: string; nativeId: string; prompt: string; hooks: readonly string[] }
/** The only place each target's argv is built; capability checks derive the required flags from it. */
function launchArgs(target: AgentId, native: boolean, { workspace, nativeId, prompt, hooks }: LaunchValues): string[] {
  switch (target) {
    case 'codex': return native ? ['resume', ...hooks, '-C', workspace, '--', nativeId, ...(prompt ? [prompt] : [])] : [...hooks, '-C', workspace, '--', prompt];
    case 'grok': return [`--cwd=${workspace}`, ...(native ? [`--resume=${nativeId}`] : ['--', prompt])];
    case 'agy': return native ? ['--conversation', nativeId] : ['--prompt-interactive', prompt];
    case 'opencode': return [workspace, ...(native ? [`--session=${nativeId}`] : [`--prompt=${prompt}`])];
    case 'claude': return native ? [`--resume=${nativeId}`, ...(prompt ? ['--', prompt] : [])] : ['--', prompt];
  }
}
/** Options this launch passes, from argv built with placeholder values that cannot be mistaken for options. Hooks are optional and checked separately. */
function launchFlags(target: AgentId, native: boolean): string[] {
  const argv = launchArgs(target, native, { workspace: 'w', nativeId: 'i', prompt: 'p', hooks: [] });
  const end = argv.indexOf('--');
  return (end < 0 ? argv : argv.slice(0, end)).filter(arg => arg.startsWith('-')).map(arg => arg.split('=', 1)[0]!);
}
/** An option line starts with the flag, optionally after a short alias, so prose mentions and longer flags do not count. */
const advertises = (help: string, flag: string): boolean => new RegExp(`^[ \\t]*(?:-\\w,[ \\t]*)?${flag}(?![\\w-])`, 'm').test(help);
async function capabilities(target: AgentId, native: boolean, executable: string, cwd: string, env: NodeJS.ProcessEnv, timeout: number, signal?: AbortSignal): Promise<{version:string;observer:boolean}> {
  const version = await probe(executable, ['--version'], cwd, env, timeout, signal);
  const reported = version.slice(0, 80).replace(/[^\x20-\x7e]/g, ' ').trim();
  const detected = reported ? reported + (version.length > 80 ? '…' : '') : 'unknown';
  const help = await probe(executable, ['--help'], cwd, env, timeout, signal);
  // Codex resume flags belong to its resume subcommand, so they are advertised in that subcommand's help.
  const launchHelp = target === 'codex' && native ? await probe(executable, ['resume', '--help'], cwd, env, timeout, signal) : help;
  const absent = launchFlags(target, native).filter(flag => !advertises(launchHelp, flag));
  if (absent.length) return fail('UNSUPPORTED_CAPABILITY', `${agentCatalog.find(agent => agent.id === target)?.label ?? target} capability is missing: help does not advertise ${absent.join(', ')}.`);
  return {version:detected,observer:process.platform!=='win32'&&target==='codex'&&/--config\s+<key=value>/.test(help)};
}
function available(guard: OwnedSessionGuard, source: SessionSource): void {
  const state = guard.check(source);
  if (state !== 'idle') fail(state === 'active' ? 'ACTIVE_SESSION' : 'UNKNOWN_OWNER', `Native session ownership is ${state}. Stop the owner or explicitly choose a fresh handoff; no takeover was attempted.`);
}
function terminalState(): string {
  if (process.platform === 'win32') {
    return windowsConsoleMode() ?? fail('TERMINAL_STATE', 'Cannot snapshot the Windows console. Launch agentswitch in a Windows terminal.');
  }
  // stty is a system utility on supported Linux/macOS hosts; argv is constant, no shell.
  const result = spawnSync('stty', ['-g'], { stdio: [0, 'pipe', 'ignore'], encoding: 'utf8', timeout: 1000, maxBuffer: 4096 });
  if (result.status !== 0 || !result.stdout.trim()) return fail('TERMINAL_STATE', 'Cannot snapshot terminal state with stty. Check terminal availability before launching.');
  return result.stdout.trim();
}

export function createRuntime(options: RuntimeOptions) {
  const env = { ...(options.env ?? process.env) };
  const guard = options.guard ?? processOwnedSessionGuard;
  const limit = options.promptByteLimit ?? MAX_INITIAL_PROMPT_BYTES;
  const timeout = options.probeTimeoutMs ?? 2000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INITIAL_PROMPT_BYTES) fail('INVALID_LIMIT', 'Prompt byte limit must be between 1 and 16384.');
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10000) fail('INVALID_LIMIT', 'Probe timeout must be between 1 and 10000 milliseconds.');
  const snapshots = new WeakMap<LaunchPlan, Snapshot>();
  return {
    async prepare(request: ContinuationRequest, input: RuntimeInput = {}, signal?: AbortSignal): Promise<PreparedContinuation<LaunchPlan>> {
      cancelled(signal);
      const source = await options.getSource(request.source, signal);
      if (source.id !== request.source.id || source.nativeId !== request.source.nativeId || source.agent !== request.source.agent)
        return fail('SOURCE_IDENTITY', 'Source identity changed. Refresh the catalog and prepare again.');
      if (!['codex', 'claude', 'opencode', 'agy', 'grok'].includes(request.target) || !['codex', 'claude', 'opencode', 'agy', 'grok'].includes(source.agent)) return fail('UNSUPPORTED_TARGET', 'Unsupported source or target agent.');
      if (!['source', 'override'].includes(request.workspace.kind)) return fail('WORKSPACE_CHOICE', 'An explicit source or override workspace choice is required.');
      const workspace = await directory(request.workspace.path);
      if (request.workspace.kind === 'source' && workspace.path !== (await directory(source.workspace)).path)
        return fail('WORKSPACE_CHOICE', 'Workspace does not match the recorded source workspace. Choose an explicit override.');
      if (input.mode !== undefined && !['auto', 'fresh'].includes(input.mode)) return fail('INVALID_MODE', 'Continuation mode must be auto or explicitly fresh.');
      const targetSource=input.resumeTarget??source;
      const native = targetSource.agent === request.target && input.mode !== 'fresh';
      if(input.resumeTarget&&targetSource.workspace!==workspace.path)return fail('WORKSPACE_CHOICE','Earlier native target workspace differs from the selected workspace.');
      if (native && !(request.target==='opencode'?openCodeNativeId:uuid).test(targetSource.nativeId)) return fail('INVALID_NATIVE_ID', 'Native resume requires the exact source UUID or provider-native ses_ identifier. Refresh or explicitly choose a fresh handoff.');
      if (native && targetSource.nativeResume !== 'compatible') return fail('INCOMPATIBLE_NATIVE', 'Native session compatibility is unavailable. Explicitly choose a fresh handoff or use the native client.');
      if (native && opensWithoutRequest(request.target)) {
        const refusal = nativeOpenRefusal(request.workspace.kind === 'source' && workspace.path === (await directory(targetSource.workspace)).path, input.handoff ? undefined : input.currentRequest);
        if (refusal) throw refusal;
      }
      if (native) available(guard, targetSource);
      if (!native && !input.handoff) return fail('HANDOFF_REQUIRED', 'A prepared historical user prompt and distinct current request are required for a fresh handoff.');
      const prompt = input.handoff?.prompt??input.currentRequest??'';
      if (prompt.includes('\0')) return fail('INVALID_PROMPT', 'Initial user prompt contains NUL and cannot be transported.');
      if (Buffer.byteLength(prompt, 'utf8') > limit) return fail('PROMPT_TOO_LARGE', `Complete initial user prompt exceeds the ${limit} byte transport limit. Reduce the prepared selection before confirming.`);
      const executable = await resolveExecutable(options.executables?.[request.target] ?? request.target, env, request.target);
      const identity = await executableIdentity(executable);
      const capability = await capabilities(request.target, native, executable, workspace.path, env, timeout, signal);
      if(input.requireReceipt&&!capability.observer)return fail('RECEIPT_UNAVAILABLE','Native receipt capability is unavailable; review a fresh bounded rebuild.');
      if (await executableIdentity(executable) !== identity) return fail('EXECUTABLE_CHANGED', 'Target executable changed during preparation. Prepare and confirm again.');
      cancelled(signal);
      const observer=Boolean(capability.observer&&input.observerCommand);
      const hooks=observer?['UserPromptSubmit','Stop'].flatMap(event=>['-c',`hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(input.observerCommand)},timeout=5}]}]`]):[];
      const args = launchArgs(request.target, native, { workspace: workspace.path, nativeId: targetSource.nativeId, prompt, hooks });
      const plan: LaunchPlan = Object.freeze({ mode: native ? 'native-resume' : 'fresh-handoff', target: request.target, executable, args: Object.freeze(args), workspace: workspace.path, version:capability.version,nativeTarget:native?{id:targetSource.id,agent:targetSource.agent,nativeId:targetSource.nativeId}:null,observer:observer?'codex-hooks':'none' });
      const identitySource = Object.freeze({ id: source.id, agent: source.agent, nativeId: source.nativeId });
      snapshots.set(plan, { source: plan.nativeTarget??identitySource, workspacePath: request.workspace.path, workspaceIdentity: workspace.identity, executableIdentity: identity, used: false });
      return { plan, summary: { source: identitySource, target: request.target, mode: plan.mode, workspace: plan.workspace,
        includedItemIds: input.handoff?[...input.handoff.includedItemIds]:[], omittedItemIds: input.handoff?[...input.handoff.omittedItemIds]:[] } };
    },
    async launch(plan: LaunchPlan, { signal, beforeSpawn, onSpawn, observer }: { signal?: AbortSignal; beforeSpawn?: () => void; onSpawn?: (pid: number) => void; observer?:{journal:string;attempt:string;token:string;root:string;rootPath:string} } = {}): Promise<LaunchResult> {
      cancelled(signal);
      const snapshot = snapshots.get(plan);
      if (!snapshot || snapshot.used) return fail('INVALID_PLAN', 'Expected an unused plan prepared by this runtime. Prepare and confirm again; never blindly retry delivery.');
      const workspace = await directory(snapshot.workspacePath);
      if (workspace.path !== plan.workspace || workspace.identity !== snapshot.workspaceIdentity) return fail('WORKSPACE_CHANGED', 'Workspace changed since confirmation. Prepare and confirm again.');
      if (await executableIdentity(plan.executable) !== snapshot.executableIdentity) return fail('EXECUTABLE_CHANGED', 'Target executable changed since preparation. Prepare and confirm again.');
      cancelled(signal);
      if (plan.mode === 'native-resume') available(guard, snapshot.source);
      if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY || process.stdin.isRaw)
        return fail('TERMINAL_REQUIRED', 'Launch requires inherited stdin/stdout/stderr terminals after picker cleanup.');
      if (terminalOwned) return fail('TERMINAL_BUSY', 'Another interactive child owns this process terminal. Wait for it to finish before launching.');
      const state = terminalState();
      terminalOwned = true;
      let releaseNative: () => void;
      try { releaseNative = plan.mode === 'native-resume' ? guard.acquire(snapshot.source) : () => {}; }
      catch (error) { terminalOwned = false; throw error; }
      const release = () => { try { releaseNative(); } finally { terminalOwned = false; } };
      if (signal?.aborted) { release(); return fail('CANCELLED', 'Continuation cancelled before launch.'); }
      try { beforeSpawn?.(); } catch (error) { release(); throw error; }
      snapshot.used = true;
      return new Promise<LaunchResult>((resolve, reject) => {
        let child: ReturnType<typeof spawn>;
        const launchEnv={...env};delete launchEnv.AGENTSWITCH_OBSERVER;
        if(plan.observer==='codex-hooks'&&observer)launchEnv.AGENTSWITCH_OBSERVER=JSON.stringify(observer);
        const [program, argv] = invocation(plan.executable, plan.args);
        try { child = spawn(program, argv, { cwd: plan.workspace, env:launchEnv, shell: false, stdio: 'inherit' }); }
        catch { release(); return reject(new RuntimeError('LAUNCH_FAILED', 'Target launch failed before process creation. Check installation, workspace and OS argument limits; prepare again.')); }
        let launched = false; let error = false; let observationError: unknown;
        const timers = new Set<ReturnType<typeof setTimeout>>();
        const forward = (name: NodeJS.Signals, delay = 75) => {
          // Foreground Ctrl+C already reaches both processes. Give native exit priority.
          const timer = setTimeout(() => { timers.delete(timer); if (child.exitCode === null && child.signalCode === null) child.kill(name); }, delay);
          timers.add(timer);
        };
        const interrupt = () => forward('SIGINT');
        const terminate = () => forward('SIGTERM');
        const abort = () => forward('SIGTERM', 0);
        process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
        signal?.addEventListener('abort', abort, { once: true });
        child.on('spawn', () => { launched = true; try { if (child.pid) onSpawn?.(child.pid); } catch (caught) { observationError = caught; } if (signal?.aborted) abort(); });
        child.on('error', () => { error = true; });
        child.on('close', (code, exitSignal) => {
          for (const timer of timers) clearTimeout(timer);
          process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
          signal?.removeEventListener('abort', abort); release();
          const windows = process.platform === 'win32';
          if (windows) process.stdout.write('\x1b[?25h');
          const restored = windows ? windowsConsoleMode(state) === 'ok'
            : spawnSync('stty', [state], { stdio: [0, 'ignore', 'ignore'], timeout: 1000 }).status === 0;
          if (!windows) process.stdout.write('\x1b[?25h\x1b[?1049l');
          if (!restored) return reject(new RuntimeError('TERMINAL_RESTORE', 'Target stopped but terminal restoration failed. Restore your terminal manually; delivery remains uncertain.'));
          if (error || !launched) return reject(new RuntimeError('LAUNCH_FAILED', 'Cannot launch target executable. Check installation, permissions, workspace and OS argument limits. No automatic retry was attempted.'));
          if (observationError) return reject(new RuntimeError('OBSERVATION_FAILED', 'Target launched but durable launch observation failed. Delivery remains uncertain.'));
          resolve({ launched: true, code, signal: exitSignal, consumption: 'unknown', ...((code !== 0 || exitSignal) ? { recovery: 'Read the native diagnostic above. Check target authentication and workspace access in its own client; confirm delivery before any retry.' } : {}) });
        });
      });
    },
  };
}
