#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { updateInstallation, updateNotice } from './update.js';
import { runArchiveCommand } from './archive-cli.js';
import { purgeSearchCache, runApplication, runTransferCommand } from './application.js';
import { demoSessions } from './tui/demo.js';
import { runDemo } from './tui/app.js';

const help = `agentswitch — coding-agent session switcher

Usage: agentswitch [--demo] [--global] [--help] [--version]
       agentswitch transfers list|show|retry|abort|delete [transfer-id]
       agentswitch update
       agentswitch cache purge
       agentswitch archive list|read|delete --directory <dir> --archive <id>
         [--item <ordinal>] [--cursor <offset>] [--limit <count>] [--max-bytes <bytes>]

  --demo       Browse synthetic sessions; never launches an agent
  --global     Start in global scope
  --help       Show this help
  --version    Show installed package version

Read-only native roots: CODEX_HOME, CODEX_SQLITE_HOME, CLAUDE_CONFIG_DIR,
OPENCODE_DB, XDG_DATA_HOME, AGENTSWITCH_AGY_ROOT, GROK_HOME.
Private local state: AGENTSWITCH_STATE_DIR (defaults to LocalAppData on Windows
and XDG_STATE_HOME on Linux/macOS, under agentswitch). AGENTSWITCH_SEARCH_CACHE_MIB
lowers the 256 MiB search cache cap. Unpinned archives expire after 30 days.
Default operation requires a terminal. Use --demo for synthetic sessions.
Transfers remain uncertain without a trusted provider consumption receipt.`;

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const installedVersion = (): string => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

async function main(): Promise<void> {
  if (process.argv[2] === 'update') {
    if (process.argv.length !== 3) throw new Error('Usage: agentswitch update');
    console.log(await updateInstallation(packageRoot));
    return;
  }
  if(process.argv[2]==='cache') {if(process.argv.length!==4||process.argv[3]!=='purge')throw new Error('Usage: agentswitch cache purge');await purgeSearchCache();console.log('Derived search cache purged. Native history and transfer archives are unchanged.');return;}
  if (process.argv[2] === 'transfers') {
    const result=await runTransferCommand(process.argv.slice(3));
    if(result!==undefined) console.log(result);
    else {if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Fresh recovery requires an interactive terminal.');await runApplication({workspace:process.cwd(),retry:process.argv[4]!});}
    return;
  }
  if (process.argv[2] === 'archive') { console.log(await runArchiveCommand(process.argv.slice(3))); return; }
  const { values } = parseArgs({ options: {
    demo: { type: 'boolean' }, global: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (values.help) { console.log(help); return; }
  if (values.version) { console.log(installedVersion()); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The picker requires an interactive terminal. Use --help for commands.');
  if(values.demo) await runDemo(demoSessions(process.cwd()), process.cwd(), values.global ? 'global' : 'folder');
  else await runApplication({
    workspace: process.cwd(), scope: values.global ? 'global' : 'folder',
    checkNotice: (state, signal) => updateNotice(packageRoot, installedVersion(), state, signal),
  });
}

main().catch((error: unknown) => {
  console.error(`agentswitch: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
