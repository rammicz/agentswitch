import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, RuntimeError } from '../dist/runtime.js';

const fake = String.raw`#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.CAP_LOG, JSON.stringify(args) + '\n');
if (args[0] === '--version') process.stdout.write(process.env.CAP_VERSION);
else if (args.includes('--help')) console.log(args[0] === 'resume' ? process.env.CAP_RESUME_HELP : process.env.CAP_HELP);
`;
const tested = {
  codex: 'codex-cli 0.171.0', claude: '2.1.330 (Claude Code)', opencode: '1.19.6', agy: '1.5.14', grok: 'grok 1.0.45 (c33bff361a6f)',
};
// Usage lines and descriptions differ from the tested releases; only the flags passed at launch remain.
const reworded = {
  codex: { help: 'Usage: codex [OPTIONS] [PROMPT] [EXTRA]...\n\nOptions:\n  -c, --config <key=value>\n  -C, --cd <WORKSPACE>\n          Pick a directory', resume: 'Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]... [MORE]\n  -C, --cd <DIR>  Where to work' },
  claude: { help: 'Usage: claude [options] [command] [prompt] [more]\n\nOptions:\n  -r, --resume [session-id]  Pick up a saved session' },
  grok: { help: 'Grok\n\nUsage: grok [OPTIONS] [PROMPT]... [COMMAND]\n\nArguments:\n  [PROMPT]...  Start with this text\n\nOptions:\n      --cwd <DIR>\n          Directory\n  -r, --resume [<ID>]\n          Open a saved session' },
  agy: { help: 'Usage of agy (new):\n  --conversation        Open an existing conversation\n  --prompt              Alias for --print\n  --prompt-interactive  Start interactively with a prompt' },
  opencode: { help: 'Commands:\n  opencode [dir]  start the tui\n\nOptions:\n  -s, --session  which session  [string]\n      --prompt   initial text   [string]' },
};
// Flags each mode's argv passes; Codex fresh options are read from --help, its resume options from resume --help.
const required = {
  fresh: { codex: ['-C'], claude: [], grok: ['--cwd'], agy: ['--prompt-interactive'], opencode: ['--prompt'] },
  native: { codex: ['-C'], claude: ['--resume'], grok: ['--cwd', '--resume'], agy: ['--conversation'], opencode: ['--session'] },
};
const modes = Object.keys(required);
const helpKey = (mode, target) => target === 'codex' && mode === 'native' ? 'resume' : 'help';
const without = (text, flag) => text.split('\n').filter(line => !new RegExp(`^[ \\t]*(?:-\\w,[ \\t]*)?${flag}(?![\\w-])`).test(line)).join('\n');

async function prepare(t, target, { mode = 'fresh', version = tested[target], help = reworded[target].help, resume = reworded[target].resume } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentswitch-capabilities-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), executable = join(root, target + '.mjs'), log = join(root, 'events');
  await mkdir(workspace); await writeFile(log, ''); await writeFile(executable, fake, { mode: 0o700 });
  const native = mode === 'native';
  const source = { id: 'source', nativeId: native && target === 'opencode' ? 'ses_synthetic001' : '12345678-1234-1234-1234-123456789abc', agent: native ? target : 'codex' };
  const runtime = createRuntime({
    executables: { [target]: executable },
    env: { ...process.env, CAP_LOG: log, CAP_VERSION: version, CAP_HELP: help, CAP_RESUME_HELP: resume ?? '' },
    getSource: async () => ({ ...source, workspace, nativeResume: 'compatible' }),
  });
  const events = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const run = () => runtime.prepare({ source, target, workspace: { kind: 'source', path: workspace } },
    native ? { currentRequest: '' } : { mode: 'fresh', handoff: { prompt: 'history', includedItemIds: [], omittedItemIds: [] } });
  return { run, events };
}
const onlyProbes = events => events.every(args => args.at(-1) === '--version' || args.at(-1) === '--help');

const versions = [
  ['codex', 'codex-cli 0.172.0'], ['claude', '2.1.331 (Claude Code)'], ['opencode', '1.18.32'], ['agy', '1.5.16'],
  ['grok', 'grok 1.0.92 (b06756fd6256) [stable]'], ...Object.keys(tested).map(target => [target, 'garbage']),
];
for (const [target, version] of versions) test(`${target} prepares with reported version ${JSON.stringify(version)}`, async t => {
  const f = await prepare(t, target, { version });
  assert.equal((await f.run()).plan.version, version);
});
test('reported version is sanitized and bounded, and an empty version still prepares', async t => {
  assert.equal((await (await prepare(t, 'claude', { version: '\x1b[31m9.9.9\x07 (Claude Code)\n' })).run()).plan.version, '[31m9.9.9  (Claude Code)');
  assert.equal((await (await prepare(t, 'claude', { version: 'v'.repeat(200) })).run()).plan.version, 'v'.repeat(80) + '…');
  assert.equal((await (await prepare(t, 'claude', { version: '' })).run()).plan.version, 'unknown');
});
for (const mode of modes) for (const target of Object.keys(tested)) test(`${target} ${mode} prepares with reworded help that lists its launch flags`, async t => {
  const f = await prepare(t, target, { mode });
  const { plan } = await f.run();
  assert.equal(plan.mode, mode === 'native' ? 'native-resume' : 'fresh-handoff');
  const events = await f.events();
  assert.ok(onlyProbes(events));
  assert.equal(events.some(args => args[0] === 'resume'), target === 'codex' && mode === 'native');
});
const missing = modes.flatMap(mode => Object.entries(required[mode]).flatMap(([target, flags]) => flags.map(flag => {
  const key = helpKey(mode, target);
  return [mode, target, flag, key, { mode, [key]: without(reworded[target][key], flag) }];
})));
for (const [mode, target, flag, key, override] of missing) test(`${target} ${mode} fails before launch when ${key === 'resume' ? 'resume ' : ''}help lacks ${flag}`, async t => {
  const f = await prepare(t, target, override);
  await assert.rejects(f.run(), e => e instanceof RuntimeError && e.code === 'UNSUPPORTED_CAPABILITY' && e.message.includes(flag));
  assert.ok(onlyProbes(await f.events()));
});
// A flag only the other mode passes, removed from the help that mode reads, does not block this mode.
const otherOnly = modes.flatMap(mode => Object.keys(tested).flatMap(target => {
  const other = modes.find(m => m !== mode), key = helpKey(other, target);
  const unused = required[other][target].filter(flag => key !== helpKey(mode, target) || !required[mode][target].includes(flag));
  return unused.length ? [[mode, target, unused, key, { mode, [key]: unused.reduce(without, reworded[target][key]) }]] : [];
}));
for (const [mode, target, unused, key, override] of otherOnly) test(`${target} ${mode} prepares when ${key === 'resume' ? 'resume ' : ''}help lacks ${unused.join(', ')} used only by the other mode`, async t => {
  const f = await prepare(t, target, override);
  await f.run();
  assert.ok(onlyProbes(await f.events()));
});
const lookalikes = [
  ['fresh', 'opencode', '--prompt', reworded.opencode.help.replace('    --prompt   initial text', '    --prompt-file  initial text')],
  ['native', 'opencode', '--session', reworded.opencode.help.replace('-s, --session  which session', '    --session-id  which session').replace('initial text', 'initial text (use with --session)')],
  ['fresh', 'agy', '--prompt-interactive', without(reworded.agy.help, '--prompt-interactive') + '\n  -i  Short alias for --prompt-interactive'],
  ['native', 'claude', '--resume', 'Usage: claude [options]\n  -c, --continue  Continue; see `--resume` and claude --resume for saved sessions'],
  ['fresh', 'grok', '--cwd', reworded.grok.help.replace('      --cwd <DIR>', '      --cwdx <DIR>')],
];
for (const [mode, target, flag, help] of lookalikes) test(`${target} ${mode} ${flag} mentioned only in prose or as a longer flag is not advertised`, async t => {
  const f = await prepare(t, target, { mode, help });
  await assert.rejects(f.run(), e => e instanceof RuntimeError && e.code === 'UNSUPPORTED_CAPABILITY');
  assert.ok(onlyProbes(await f.events()));
});
