import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { findUpdate, updateInstallation, updateNotice } from '../dist/update.js';

const repo = 'https://github.com/rammicz/agentswitch/releases/download';
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const signal = () => new AbortController().signal;
const release = (version, bytes = Buffer.from('test package')) => ({
  tag_name: `v${version}`, draft: false, prerelease: version.includes('-'),
  assets: [{
    name: `agentswitch-${version}.tgz`, state: 'uploaded', size: bytes.length, digest: digest(bytes),
    browser_download_url: `${repo}/v${version}/agentswitch-${version}.tgz`,
  }],
});

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agentswitch-updater-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'lib', 'node_modules', 'agentswitch');
  const metadata = join(root, 'package.json');
  const executable = join(directory, 'bin', 'agentswitch');
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(dirname(executable));
  await writeFile(metadata, JSON.stringify({ name: 'agentswitch', version: '0.1.0-dev.0' }));
  await writeFile(join(root, 'dist', 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  await symlink('../lib/node_modules/agentswitch/dist/cli.js', executable);
  return { directory, root, metadata, executable };
}

test('release selection follows numeric prerelease order and restricts the download origin', async () => {
  const foreign = release('5.0.0');
  foreign.assets[0].browser_download_url = 'https://example.invalid/update.tgz';
  const draft = { ...release('4.0.0'), draft: true };
  const request = async () => Response.json([release('0.1.0-dev.2'), release('0.1.0-dev.10'), foreign, draft]);
  assert.equal((await findUpdate('0.1.0-dev.0', signal(), request)).version, '0.1.0-dev.10');
  assert.equal(await findUpdate('0.1.0', signal(), request), undefined);
  assert.equal(await findUpdate('0.1.0-dev.11', signal(), request), undefined);
  const pages = async url => url.endsWith('page=1')
    ? Response.json([release('0.2.0')], { headers: { link: '<ignored>; rel="next"' } })
    : Response.json([release('0.3.0')]);
  assert.equal((await findUpdate('0.1.0', signal(), pages)).version, '0.3.0');
});

test('ordinary opens share one daily check and reuse its notice without downloading', async t => {
  const { root, directory } = await fixture(t);
  let checks = 0;
  const request = async url => {
    assert.match(url, /^https:\/\/api\.github\.com\/repos\/rammicz\/agentswitch\/releases\?/);
    checks++;
    return Response.json([release('0.1.0-dev.1')]);
  };
  const check = () => updateNotice(root, '0.1.0-dev.0', directory, signal(), request);
  const first = await Promise.all([check(), check()]);
  assert.ok(first.some(notice => /Run agentswitch update/.test(notice ?? '')));
  assert.equal(await check(), 'Update 0.1.0-dev.1 available. Run agentswitch update.');
  assert.equal(checks, 1);
});

test('explicit update validates the tarball and replaces the same global npm installation', async t => {
  const { directory, root, metadata, executable } = await fixture(t);
  const input = join(directory, 'candidate');
  await mkdir(join(input, 'dist'), { recursive: true });
  await writeFile(join(input, 'package.json'), JSON.stringify({
    name: 'agentswitch', version: '0.1.0-dev.1', bin: { agentswitch: 'dist/cli.js' },
    scripts: { postinstall: 'exit 99' },
  }));
  await writeFile(join(input, 'dist', 'cli.js'), '#!/usr/bin/env node\nconsole.log("updated");\n', { mode: 0o755 });
  const npm = await realpath(join(dirname(process.execPath), 'npm'));
  const pack = spawnSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', input], { cwd: directory, encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr);
  const bytes = await readFile(join(directory, JSON.parse(pack.stdout)[0].filename));
  const candidate = release('0.1.0-dev.1', bytes);
  const request = async url => url === candidate.assets[0].browser_download_url
    ? new Response(bytes) : Response.json([candidate]);
  const originalDigest = candidate.assets[0].digest;
  candidate.assets[0].digest = digest(Buffer.from('wrong package'));
  await assert.rejects(updateInstallation(root, request), /SHA-256/);
  assert.equal(JSON.parse(await readFile(metadata, 'utf8')).version, '0.1.0-dev.0');
  candidate.assets[0].digest = originalDigest;
  assert.match(await updateInstallation(root, request), /Updated agentswitch/);
  assert.equal(JSON.parse(await readFile(metadata, 'utf8')).version, '0.1.0-dev.1');
  assert.equal(spawnSync(process.execPath, [executable], { encoding: 'utf8' }).stdout.trim(), 'updated');
  assert.match(await updateInstallation(root, request), /No newer/);
});
