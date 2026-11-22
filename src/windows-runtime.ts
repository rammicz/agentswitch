import { spawnSync } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { AgentId } from './domain.js';

const packages: Partial<Record<AgentId, string>> = {
  codex: '@openai/codex', claude: '@anthropic-ai/claude-code', opencode: 'opencode-ai',
};

/** Resolve known npm packages behind their cmd shims without interpreting batch code. */
export async function windowsNpmEntry(shim: string, agent: AgentId): Promise<string | undefined> {
  const name = packages[agent];
  if (!name || !(await lstat(shim)).isFile()) return;
  const directory = dirname(shim);
  const modules = basename(directory).toLowerCase() === '.bin' ? dirname(directory) : join(directory, 'node_modules');
  const root = await realpath(join(modules, name));
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (metadata.name !== name) return;
  const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.[agent];
  if (typeof bin !== 'string' || isAbsolute(bin) || bin.includes(':')) return;
  const entry = await realpath(join(root, bin));
  const path = relative(root, entry);
  if (isAbsolute(path) || path === '..' || path.startsWith('..' + sep)) return;
  if (/\.(?:exe|[cm]?js)$/i.test(entry) && (await lstat(entry)).isFile()) return entry;
  // Some npm packages use extensionless Node entry points.
  if (!/\.[^\\/]+$/.test(bin) && (await lstat(entry)).isFile()) {
    const contents = await readFile(entry, 'utf8');
    if (/^#![^\r\n]*\bnode\b/.test(contents)) return entry;
  }
}

// Read the attached console even when stdout is redirected to capture the two flags.
const consoleBoilerplate = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgentSwitchConsole {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr attrs, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetConsoleMode(IntPtr handle, out uint mode);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetConsoleMode(IntPtr handle, uint mode);
}
'@
$inputHandle = [AgentSwitchConsole]::CreateFile('CONIN$', [uint32]3221225472, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
$outputHandle = [AgentSwitchConsole]::CreateFile('CONOUT$', [uint32]3221225472, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
`;

export function windowsConsoleMode(state?: string): string | undefined {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) return;
  const ps = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (state !== undefined && !/^\d{1,10}:\d{1,10}$/.test(state)) return;
  const [inputMode, outputMode] = state?.split(':') ?? [];
  const script = state === undefined ? String.raw`
[uint32]$inputMode = 0; [uint32]$outputMode = 0
if (![AgentSwitchConsole]::GetConsoleMode($inputHandle, [ref]$inputMode) -or ![AgentSwitchConsole]::GetConsoleMode($outputHandle, [ref]$outputMode)) { exit 1 }
[Console]::WriteLine(('{0}:{1}' -f $inputMode, $outputMode))
` : `
$inputRestored = [AgentSwitchConsole]::SetConsoleMode($inputHandle, [uint32]${inputMode})
$outputRestored = [AgentSwitchConsole]::SetConsoleMode($outputHandle, [uint32]${outputMode})
if (!$inputRestored -or !$outputRestored) { exit 1 }
[Console]::WriteLine('ok')
`;
  const encoded = Buffer.from(consoleBoilerplate + script, 'utf16le').toString('base64');
  const result = spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    shell: false, stdio: [0, 'pipe', 'ignore'], encoding: 'utf8', timeout: 12_000, maxBuffer: 4096,
  });
  if (result.status === 0 && (state === undefined ? /^\d{1,10}:\d{1,10}$/.test(result.stdout.trim()) : result.stdout.trim() === 'ok')) {
    return result.stdout.trim();
  }
}
