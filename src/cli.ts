#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { demoSessions } from './tui/demo.js';
import { runDemo } from './tui/app.js';

const help = `agentswitch — coding-agent session switcher (development scaffold)

Usage: agentswitch [--demo] [--global] [--help] [--version]

  --demo       Browse synthetic sessions; never launches an agent
  --global     Start demo in global scope (requires --demo)
  --help       Show this help
  --version    Show scaffold version

Real Codex/Claude discovery and conversation transfer are planned.
Run agentswitch --demo to explore the proposed interaction.`;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    demo: { type: 'boolean' }, global: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (values.help) { console.log(help); return; }
  if (values.version) { console.log('0.1.0-dev.0'); return; }
  if (values.global && !values.demo) throw new Error('--global currently requires --demo.');
  if (!values.demo) { console.log(help); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('--demo requires an interactive terminal.');
  await runDemo(demoSessions(process.cwd()), process.cwd(), values.global ? 'global' : 'folder');
}

main().catch((error: unknown) => {
  console.error(`agentswitch: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
