import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, release, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--output'), 'Usage: node scripts/check-distribution.mjs [--output <new-directory-outside-checkout>]');
const requestedOutput = args.length ? resolve(args[1]) : mkdtempSync(join(tmpdir(), 'agentswitch-artifact-'));
const output = join(realpathSync(dirname(requestedOutput)), basename(requestedOutput));
const outputRelative = relative(realpathSync(root), output);
assert.ok(isAbsolute(outputRelative) || (outputRelative !== '' && outputRelative !== '..' && outputRelative.startsWith('../')), 'Artifacts must be outside the checkout');
if (args.length) mkdirSync(output, { mode: 0o700 });
const work = realpathSync(mkdtempSync(join(tmpdir(), 'agentswitch-install-')));
const prefix = join(work, 'prefix with spaces');
const workspace = join(work, 'workspace with spaces');
for (const path of [prefix, workspace, 'home', 'cache', 'tmp', 'config', 'codex', 'codex-sqlite', 'claude', 'xdg-state'].map(path => isAbsolute(path) ? path : join(work, path))) mkdirSync(path, { mode: 0o700 });
const userConfig = join(work, 'user.npmrc');
const globalConfig = join(work, 'global.npmrc');
writeFileSync(userConfig, '');
writeFileSync(globalConfig, '');
// Construct a fresh environment: inherited provider settings and npm credentials never enter a child.
const env = {
  PATH: `${dirname(process.execPath)}:${join(prefix, 'node_modules/.bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: join(work, 'home'), TMPDIR: join(work, 'tmp'), LANG: 'C',
  XDG_CONFIG_HOME: join(work, 'config'), XDG_CACHE_HOME: join(work, 'cache'), XDG_STATE_HOME: join(work, 'xdg-state'),
  CODEX_HOME: join(work, 'codex'), CODEX_SQLITE_HOME: join(work, 'codex-sqlite'), CLAUDE_CONFIG_DIR: join(work, 'claude'),
  AGENTSWITCH_STATE_DIR: join(work, 'application-state'),
  NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, NPM_CONFIG_CACHE: join(work, 'cache'),
  NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false',
};
const npmCli = realpathSync(process.env.npm_execpath || join(dirname(process.execPath), 'npm'));
const report = { sourceCommit: null, sourceDirty: null, node: process.version, npm: null, os: platform(), osRelease: release(), arch: arch(), checks: [], passed: false };
function command(file, argv, cwd = workspace, expected = 0) {
  const result = spawnSync(file, argv, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${file} ${argv.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const npm = (argv, cwd = workspace) => command(process.execPath, [npmCli, ...argv], cwd);
function checked(name, action) { const value = action(); report.checks.push(name); return value; }
function executableFromPath(name) {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    try {
      const candidate = realpathSync(resolve(directory || '.', name));
      accessSync(candidate, constants.X_OK);
      if (lstatSync(candidate).isFile()) return candidate;
    } catch { /* Try the next directory without reading user configuration. */ }
  }
  throw new Error(`Required executable is missing from PATH: ${name}`);
}
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = (buffer, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(buffer).digest(encoding);
const installed = join(prefix, 'node_modules/agentswitch');
const executable = join(prefix, 'node_modules/.bin/agentswitch');
function smoke(argv, status, pattern, stream = 'stdout') {
  const result = command(executable, argv, workspace, status);
  if (pattern) assert.match(result[stream], pattern);
  return result.stdout.trim();
}
try {
  assert.ok(['linux', 'darwin'].includes(process.platform), 'Distribution smoke currently supports Linux and macOS');
  report.sourceCommit = command('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  report.sourceDirty = command('git', ['status', '--porcelain'], root).stdout.trim() !== '';
  assert.throws(() => lstatSync(join(root, '.npmrc')), { code: 'ENOENT' }, 'Project npm configuration must be absent; move it outside the candidate checkout before packaging');
  report.npm = npm(['--version']).stdout.trim();
  const python = executableFromPath('python3');
  report.python = command(python, ['--version']).stdout.trim();
  const source = json(join(root, 'package.json'));
  const lock = json(join(root, 'package-lock.json'));
  checked('checkout and lockfile metadata agree', () => {
    assert.equal(source.version, lock.version);
    assert.equal(source.version, lock.packages[''].version);
    assert.deepEqual(source.bin, lock.packages[''].bin);
    assert.deepEqual(source.engines, lock.packages[''].engines);
  });
  // prepack must run: this verifies the build shipped to users, even with no existing dist directory.
  const pack = npm(['pack', '--json', '--pack-destination', output], root);
  writeFileSync(join(output, 'pack.json'), pack.stdout);
  const manifests = JSON.parse(pack.stdout);
  assert.equal(manifests.length, 1);
  const manifest = manifests[0];
  assert.match(manifest.filename, /^agentswitch-[a-zA-Z0-9.\-]+\.tgz$/);
  const tarball = join(output, manifest.filename);
  const bytes = readFileSync(tarball);
  checked('tarball digest and size match npm manifest', () => {
    assert.equal(bytes.length, manifest.size);
    assert.equal(hash(bytes, 'sha1'), manifest.shasum);
    assert.equal(`sha512-${hash(bytes, 'sha512', 'base64')}`, manifest.integrity);
  });
  const archiveResult = command(python, [join(root, 'scripts/inspect-package.py'), tarball]);
  const archive = JSON.parse(archiveResult.stdout);
  writeFileSync(join(output, 'archive.json'), archiveResult.stdout);
  checked('actual archive matches manifest and reviewed runtime/doc allowlist', () => {
    const actual = archive.entries.map(entry => entry.path).sort();
    const declared = manifest.files.map(entry => entry.path).sort();
    assert.deepEqual(actual, declared);
    assert.equal(manifest.entryCount, actual.length);
    for (const entry of archive.entries) assert.equal(entry.size, manifest.files.find(file => file.path === entry.path).size, entry.path);
    const tracked = command('git', ['ls-files', '-z', 'src', 'docs'], root).stdout.split('\0').filter(Boolean);
    const expected = ['package.json', 'README.md', 'LICENSE', 'AGENTS.md', 'CONTRIBUTING.md'];
    for (const path of tracked) {
      if (path.startsWith('docs/')) expected.push(path);
      else if (path.endsWith('.ts')) for (const suffix of ['.js', '.d.ts', '.js.map']) expected.push(path.replace(/^src\//, 'dist/').slice(0, -3) + suffix);
    }
    assert.deepEqual(actual, expected.sort(), 'Archive contains unexpected files or omits intended files');
    for (const path of actual) {
      assert.ok(!path.split('/').some(segment => /^(?:node_modules|test|tests|fixtures|src|coverage|\.git|\.github|\.serena|\.codex|\.claude|\.agentswitch|archives|transfers|cache|credentials?|secrets?|auth\.json|\.npmrc|\.env(?:\..*)?)$/i.test(segment)), `Forbidden distribution path: ${path}`);
      assert.ok(!/\.(?:jsonl|sqlite(?:3)?|db|pem|key|tgz)(?:-(?:wal|shm))?$|(?:-wal|-shm)$/i.test(path), `Forbidden data file: ${path}`);
      assert.ok(!path.startsWith('docs/') || /\.(?:md|txt)$/.test(path), `Unreviewed document type: ${path}`);
    }
    for (const required of ['dist/cli.js', 'dist/application.js', 'dist/archive-cli.js', 'dist/archive.js', 'dist/handoff.js', 'dist/runtime.js', 'dist/transfer-journal.js', 'docs/integration.md', 'docs/claude-sdk-license.txt']) assert.ok(actual.includes(required), `Missing required file: ${required}`);
    assert.deepEqual(archive.package, source);
    assert.equal(manifest.version, source.version);
    assert.equal(archive.package.name, 'agentswitch');
    assert.deepEqual(archive.package.bin, { agentswitch: 'dist/cli.js' });
    for (const dependencies of [archive.package.dependencies, archive.package.optionalDependencies]) assert.equal(Object.keys(dependencies || {}).length, 0, 'Offline install contract requires no runtime dependencies');
  });
  checked('two actual prepack builds produce identical tarball bytes', () => {
    const repeated = join(work, 'repeat');
    mkdirSync(repeated);
    const repeatedManifest = JSON.parse(npm(['pack', '--json', '--pack-destination', repeated], root).stdout)[0];
    assert.equal(hash(readFileSync(join(repeated, repeatedManifest.filename))), hash(bytes));
  });
  writeFileSync(join(output, 'SHA256SUMS'), `${hash(bytes)}  ${manifest.filename}\n`);
  report.version = source.version;
  report.tarball = manifest.filename;
  report.sha256 = hash(bytes);
  report.integrity = manifest.integrity;
  report.entryCount = archive.entries.length;
  const sentinel = join(prefix, 'unrelated-sentinel.txt');
  writeFileSync(sentinel, 'preserve unrelated prefix data\n');
  const installArgs = ['--prefix', prefix, '--global=false', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'];
  checked('actual tarball installs offline using empty npm storage', () => {
    env.NPM_CONFIG_CACHE = join(work, 'install-cache');
    assert.ok(!existsSync(env.NPM_CONFIG_CACHE));
    npm(['install', ...installArgs, tarball]);
  });
  checked('installed bin and PATH resolve into disposable prefix', () => {
    assert.ok(lstatSync(installed).isDirectory());
    assert.ok(lstatSync(executable).isSymbolicLink());
    assert.equal(realpathSync(executable), join(realpathSync(installed), 'dist/cli.js'));
    accessSync(executable, constants.X_OK);
    assert.ok(readFileSync(executable, 'utf8').startsWith('#!/usr/bin/env node\n'));
    assert.equal(command('/bin/sh', ['-c', 'command -v agentswitch']).stdout.trim(), executable);
    assert.equal(command('node', ['-p', 'process.execPath']).stdout.trim(), process.execPath);
    assert.deepEqual(json(join(installed, 'package.json')), archive.package);
  });
  checked('installed help and version match all release metadata', () => {
    const help = smoke(['--help'], 0, /Usage: agentswitch/);
    for (const phrase of ['--demo', '--global', 'agentswitch transfers', 'agentswitch archive', 'agentswitch cache']) assert.ok(help.includes(phrase));
    assert.equal(smoke(['--version'], 0), json(join(installed, 'package.json')).version);
    assert.equal(command('agentswitch', ['--version']).stdout.trim(), source.version);
  });
  checked('installed unknown flags and piped picker modes fail explicitly', () => {
    smoke(['--unknown'], 1, /Unknown option/, 'stderr');
    for (const argv of [[], ['--global'], ['--demo'], ['--demo', '--global']]) smoke(argv, 1, /interactive terminal/, 'stderr');
    assert.ok(!existsSync(env.AGENTSWITCH_STATE_DIR), 'Noninteractive picker must not create application state');
    smoke(['archive'], 1, /Usage: agentswitch archive/, 'stderr');
    smoke(['transfers'], 1, /Usage: agentswitch transfers/, 'stderr');
  });
  checked('installed transfer list and cache purge work with isolated state', () => {
    assert.deepEqual(JSON.parse(smoke(['transfers', 'list'], 0)), []);
    smoke(['cache', 'purge'], 0, /Derived search cache purged/);
  });
  // Load only the installed code in a fresh child with the same sterile environment.
  checked('installed archive utility retrieves and deletes synthetic public history', () => {
    const moduleUrl = pathToFileURL(join(installed, 'dist/handoff.js')).href;
    const archiveDirectory = join(work, 'synthetic archives');
    const text = 'Synthetic public history. 😀\n'.repeat(80);
    const fixture = command(process.execPath, ['--input-type=module', '-e', `
      const {prepareHandoff} = await import(${JSON.stringify(moduleUrl)});
      const prepared = await prepareHandoff({directory: ${JSON.stringify(archiveDirectory)}, source: {agent:'codex',id:'synthetic',nativeId:'synthetic'}, items:[{id:'public',role:'user',status:'complete',text:${JSON.stringify(text)}}], currentRequest:'Continue synthetic task.', maxBytes:1600});
      console.log(JSON.stringify(prepared.archive));
    `]);
    const reference = JSON.parse(fixture.stdout);
    const base = ['--directory', reference.directory, '--archive', reference.id];
    const listed = JSON.parse(smoke(['archive', 'list', ...base], 0));
    assert.equal(listed.items[0].id, 'public');
    let retrieved = ''; let cursor = 0; let pages = 0;
    do {
      const page = JSON.parse(smoke(['archive', 'read', ...base, '--item', '0', '--cursor', String(cursor), '--max-bytes', '1024'], 0));
      retrieved += page.text;
      assert.ok(page.nextCursor === null || page.nextCursor > cursor);
      cursor = page.nextCursor;
      assert.ok(++pages < 100);
    } while (cursor !== null);
    assert.equal(retrieved, text);
    smoke(['archive', 'delete', ...base], 0);
    smoke(['archive', 'read', ...base, '--item', '0'], 1, /missing|deleted/i, 'stderr');
  });
  checked('explicit offline uninstall removes package and exact bin, preserving sentinel', () => {
    npm(['uninstall', ...installArgs, 'agentswitch']);
    for (const path of [installed, executable]) assert.throws(() => lstatSync(path), { code: 'ENOENT' });
    const removed = spawnSync(executable, ['--version'], { cwd: workspace, env, encoding: 'utf8' });
    assert.equal(removed.error?.code, 'ENOENT');
    const metadata = json(join(prefix, 'package.json'));
    assert.ok(!metadata.dependencies?.agentswitch);
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve unrelated prefix data\n');
  });
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
  report.disposableStorageRemoved = !existsSync(work);
  writeFileSync(join(output, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${report.checks.length} distribution checks. Artifacts: ${output}`);
if (!report.passed) console.error(report.error);
