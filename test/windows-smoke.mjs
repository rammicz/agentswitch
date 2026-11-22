import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { completed, ids, rollout, writeRollout } from './fixtures/codex/native.mjs';

const execute = (program, args, options = {}) => {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 75_000, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
};

test('native Windows package installs, searches and hands off literal text in ConPTY', async t => {
  assert.equal(process.platform, 'win32');
  assert.ok(process.env.AGENTSWITCH_WINDOWS_TARBALL);
  const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'agentswitch win ')));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const prefix = join(workspaceRoot, 'npm install');
  const workspace = join(workspaceRoot, 'project with spaces');
  const codex = join(workspaceRoot, 'codex');
  const providerBin = join(workspaceRoot, 'providers');
  const claude = join(providerBin, 'node_modules', '@anthropic-ai', 'claude-code');
  const log = join(workspaceRoot, 'provider.jsonl');
  await mkdir(workspace);
  await mkdir(claude, { recursive: true });
  const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  execute(process.execPath, [npm, 'install', '--global', '--offline', '--ignore-scripts',
    '--no-audit', '--no-fund', '--prefix', prefix, process.env.AGENTSWITCH_WINDOWS_TARBALL], { cwd: workspace });

  const installed = join(prefix, 'node_modules', 'agentswitch');
  const cli = join(installed, 'dist', 'cli.js');
  const nodeVersion = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version;
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  const path = [prefix, providerBin, process.env.PATH].join(delimiter);
  assert.equal(execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'agentswitch.cmd --version'],
    { cwd: workspace, env: { ...cleanEnv, PATH: path } }).trim(), nodeVersion);

  await writeFile(join(providerBin, 'claude.cmd'), '@exit /b 90\r\n');
  await writeFile(join(claude, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: 'fake.mjs' } }));
  const fake = await readFile('test/fixtures/runtime-child.mjs');
  await writeFile(join(claude, 'fake.mjs'), fake);
  const prompt = 'Windows fixture & %PATH% | ^ < > "quotes"';
  const transcript = await writeRollout(codex, rollout(workspace, ids[0], [
    completed('UserMessage', 'u', prompt, 1), completed('AgentMessage', 'a', 'Synthetic answer', 2),
  ]));
  const before = await readFile(transcript);
  const state = join(workspaceRoot, 'state');
  const env = { ...cleanEnv, PATH: path, CODEX_HOME: codex, CODEX_SQLITE_HOME: codex,
    CLAUDE_CONFIG_DIR: join(workspaceRoot, 'claude data'), GROK_HOME: join(workspaceRoot, 'grok data'),
    AGENTSWITCH_AGY_ROOT: join(workspaceRoot, 'agy data'), OPENCODE_DB: join(workspaceRoot, 'opencode.db'),
    AGENTSWITCH_STATE_DIR: state, AGENTSWITCH_NO_UPDATE_CHECK: '1', RUNTIME_TARGET: 'claude',
    RUNTIME_SCENARIO: 'raw', RUNTIME_LOG: log, NODE_NO_WARNINGS: '1' };
  const driver = (steps, command = [process.execPath, cli]) => execute('python', [resolve('test/fixtures/drive-windows-console.py')], {
    cwd: workspace, env, input: JSON.stringify({ cwd: workspace, command, actions: steps }),
  });

  const runner = join(workspaceRoot, 'check-console.mjs');
  const diagnostics = join(workspaceRoot, 'diagnostic.log');
  await writeFile(runner, `
import { windowsConsoleMode } from ${JSON.stringify(pathToFileURL(join(installed, 'dist', 'windows-runtime.js')).href)};
import { appendFileSync } from 'node:fs';
const record = message => appendFileSync(${JSON.stringify(diagnostics)}, String(message) + String.fromCharCode(10));
process.on('uncaughtExceptionMonitor', error => record(error.stack));
process.on('exit', code => record('exit ' + code));
const stderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (message, ...args) => {
  record(message);
  return stderr(message, ...args);
};
console.log('WINDOWS_BASELINE');
if (!process.stdin.isTTY) throw Error('No Windows console input');
const setRawMode = process.stdin.setRawMode.bind(process.stdin);
process.stdin.setRawMode = value => {
  record('setRawMode ' + value);
  const result = setRawMode(value);
  record('setRawMode completed');
  return result;
};
const before = windowsConsoleMode();
if (!before) throw Error('Cannot read initial console mode');
process.once('beforeExit', () => {
  const after = windowsConsoleMode();
  if (after !== before) throw Error('Windows console modes did not restore: ' + before + ' -> ' + after);
  console.log('CONSOLE_RESTORED');
  // Leave enough time for the server's ConPTY output pump before the console closes.
  setTimeout(() => {}, 250);
});
await import(${JSON.stringify(pathToFileURL(cli).href)});
`);
  try {
    driver([{ wait: 'Enter preview' }, { send: 'Windows fixture' }, { wait: 'Enter preview' }, { send: '\r' },
      { wait: 'Enter choose target' }, { send: '\r' }, { wait: 'Target: codex' },
      { send: '\x1b[C' }, { wait: 'Target: claude' }, { send: '\r' }, { wait: 'Enter confirm continuation' },
      { send: '\r' }, { wait: 'READY' }, { send: 'quit\r' }, { wait: 'uncertain' }, { wait: 'CONSOLE_RESTORED' }],
      [process.execPath, runner]);
  } catch (error) {
    const journal = spawnSync(process.execPath, [cli, 'transfers', 'list'], { cwd: workspace, env, encoding: 'utf8' });
    const logs = await readFile(log, 'utf8').catch(() => '');
    throw new Error(`${await readFile(diagnostics, 'utf8').catch(() => '')}\n${journal.stdout}\n${logs}\n${error.message}`);
  }
  const actual = JSON.parse((await readFile(log, 'utf8')).trim());
  assert.deepEqual(actual.tty, [true, true, true]);
  assert.equal(actual.cwd, workspace);
  assert.equal(actual.args[0], '--');
  assert.ok(JSON.parse(actual.args[1]).history.some(item => item.text === prompt));
  assert.deepEqual(await readFile(transcript), before);
  const transfers = execute(process.execPath, [cli, 'transfers', 'list'], { cwd: workspace, env });
  assert.match(transfers, /uncertain/);
});
