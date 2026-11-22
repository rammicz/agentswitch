import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const repository = 'rammicz/agentswitch';
const releaseApi = `https://api.github.com/repos/${repository}/releases`;
const downloadBase = `https://github.com/${repository}/releases/download/`;
const maxAssetBytes = 16 * 1024 * 1024;
const day = 86_400_000;
const run = promisify(execFile);

interface Release { version: string; url: string; size: number; digest: string }
type Fetch = typeof fetch;

// Release tags use SemVer without build metadata. Keep version strings safe for URLs and filenames.
const versionPattern = /^(0|[1-9]\d{0,9})\.(0|[1-9]\d{0,9})\.(0|[1-9]\d{0,9})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
function versionParts(value: unknown): { core: number[]; pre: string[] } | undefined {
  if (typeof value !== 'string' || value.length > 100) return;
  const match = versionPattern.exec(value);
  if (!match || match[0] !== value) return;
  const pre = match[4]?.split('.') ?? [];
  if (pre.some(part => /^0\d+$/.test(part))) return;
  return { core: match.slice(1, 4).map(Number), pre };
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left)!;
  const b = versionParts(right)!;
  for (const [index, part] of a.core.entries()) {
    if (part !== b.core[index]) return part - b.core[index]!;
  }
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (const [index, first] of a.pre.entries()) {
    const second = b.pre[index];
    if (second === undefined) return 1;
    if (first === second) continue;
    const firstNumeric = /^\d+$/.test(first);
    const secondNumeric = /^\d+$/.test(second);
    if (firstNumeric !== secondNumeric) return firstNumeric ? -1 : 1;
    if (firstNumeric && first.length !== second.length) return first.length - second.length;
    return first < second ? -1 : 1;
  }
  return a.pre.length - b.pre.length;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

async function responseBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error(`GitHub returned HTTP ${response.status}.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.length;
      if (size > limit) throw new Error('GitHub response exceeded the expected size.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function findUpdate(installed: string, signal: AbortSignal, request: Fetch = fetch): Promise<Release | undefined> {
  const current = versionParts(installed);
  if (!current) throw new Error('Unsupported installed version format.');
  let newest: Release | undefined;
  for (let page = 1; page <= 10; page++) {
    const response = await request(`${releaseApi}?per_page=100&page=${page}`, {
      signal, redirect: 'error', headers: { Accept: 'application/vnd.github+json' },
    });
    const releases: unknown = JSON.parse((await responseBytes(response, 4 * 1024 * 1024)).toString('utf8'));
    if (!Array.isArray(releases)) throw new Error('Invalid release listing.');
    for (const release of releases as unknown[]) {
      if (!object(release) || release.draft !== false || typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) continue;
      const version = release.tag_name.slice(1);
      const parts = versionParts(version);
      if (!parts || release.prerelease !== Boolean(parts.pre.length)) continue;
      if (!current.pre.length && parts.pre.length) continue;
      if (compareVersions(version, newest?.version ?? installed) <= 0 || !Array.isArray(release.assets)) continue;
      const name = `agentswitch-${version}.tgz`;
      const url = `${downloadBase}v${version}/${name}`;
      const asset = (release.assets as unknown[]).find(item => object(item) && item.name === name);
      if (!object(asset) || asset.browser_download_url !== url || asset.state !== 'uploaded' ||
          typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxAssetBytes ||
          typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) continue;
      newest = { version, url, size: asset.size, digest: asset.digest.slice(7) };
    }
    if (!response.headers.get('link')?.includes('rel="next"')) return newest;
  }
  throw new Error('GitHub returned too many release pages.');
}

async function installationPrefix(packageRoot: string): Promise<string | undefined> {
  const root = await realpath(packageRoot);
  const modules = dirname(root);
  if (basename(root).toLowerCase() !== 'agentswitch' || basename(modules).toLowerCase() !== 'node_modules') return;
  const lib = dirname(modules);
  if (process.platform === 'win32') {
    const shim = join(lib, 'agentswitch.cmd');
    if ((await lstat(shim).catch(() => undefined))?.isFile() &&
        (await readFile(shim, 'utf8')).toLowerCase().includes('node_modules\\agentswitch\\dist\\cli.js')) return lib;
    return;
  }
  if (basename(lib) !== 'lib') return;
  const prefix = dirname(lib);
  const executable = await realpath(join(prefix, 'bin', 'agentswitch')).catch(() => undefined);
  if (executable === join(root, 'dist', 'cli.js')) return prefix;
}

export async function updateNotice(packageRoot: string, installed: string, state: string, signal: AbortSignal, request: Fetch = fetch): Promise<string | undefined> {
  if (process.env.AGENTSWITCH_NO_UPDATE_CHECK === '1' || !await installationPrefix(packageRoot)) return;
  signal.throwIfAborted();
  const today = Math.floor(Date.now() / day);
  const path = join(state, `update-check-${today}`);
  let marker;
  try {
    marker = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  let version: string | undefined;
  if (marker) {
    try {
      const update = await findUpdate(installed, AbortSignal.any([signal, AbortSignal.timeout(2000)]), request);
      version = update?.version;
      if (version) await marker.writeFile(version);
    } finally {
      await marker.close();
    }
    for (const entry of await readdir(state, { withFileTypes: true })) {
      const date = /^update-check-(\d+)$/.exec(entry.name);
      if (entry.isFile() && date && Number(date[1]) < today) await rm(join(state, entry.name), { force: true });
    }
  } else {
    // A concurrent check may still be writing or may have exited. A blank marker records the attempt.
    const cached = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await cached.stat();
      if (info.isFile() && info.size <= 100) version = await cached.readFile('utf8');
    } finally { await cached.close(); }
  }
  const cachedVersion = versionParts(version);
  const current = versionParts(installed);
  if (cachedVersion && current && (current.pre.length || !cachedVersion.pre.length) && compareVersions(version!, installed) > 0) {
    return `Update ${version} available. Run agentswitch update.`;
  }
}

export async function updateInstallation(packageRoot: string, request: Fetch = fetch): Promise<string> {
  const prefix = await installationPrefix(packageRoot);
  if (!prefix) throw new Error('Self-update requires a global npm install from a tarball. For a source checkout or npm link, update the checkout and rebuild.');
  const windows = process.platform === 'win32';
  const modulesRelative = windows ? 'node_modules' : join('lib', 'node_modules');
  const modules = join(prefix, modulesRelative);
  const metadata = join(modules, 'agentswitch', 'package.json');
  const lock = join(modules, '.agentswitch-update');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`An update lock exists at ${lock}. If a previous update was interrupted, remove the empty directory once the updater has stopped.`);
    throw error;
  }
  try {
    const { version: installed } = JSON.parse(await readFile(metadata, 'utf8')) as { version: string };
    const update = await findUpdate(installed, AbortSignal.timeout(15_000), request);
    if (!update) return `No newer downloadable release is available for ${installed}.`;

    const response = await request(update.url, { signal: AbortSignal.timeout(30_000) });
    const bytes = await responseBytes(response, update.size);
    if (bytes.length !== update.size || createHash('sha256').update(bytes).digest('hex') !== update.digest) {
      throw new Error('Downloaded package failed SHA-256 verification.');
    }
    const nodeDirectory = dirname(process.execPath);
    const npm = await realpath(join(nodeDirectory, windows ? 'node_modules/npm/bin/npm-cli.js' : 'npm')).catch(() => undefined);
    if (!npm) throw new Error('npm must be installed alongside the active Node executable.');
    const directory = await mkdtemp(join(tmpdir(), 'agentswitch-update-'));
    try {
      const tarball = join(directory, `agentswitch-${update.version}.tgz`);
      const userConfig = join(directory, 'user.npmrc');
      const globalConfig = join(directory, 'global.npmrc');
      await writeFile(tarball, bytes);
      await writeFile(userConfig, '');
      await writeFile(globalConfig, '');
      const systemRoot = process.env.SystemRoot;
      const systemPath = windows && systemRoot ? join(systemRoot, 'System32') : '/usr/bin:/bin';
      const env = { PATH: [nodeDirectory, systemPath].join(delimiter), HOME: directory,
        ...(windows ? { SystemRoot: systemRoot, WINDIR: systemRoot, USERPROFILE: directory, TEMP: directory, TMP: directory } : {}),
      };
      const install = (destination: string) => run(process.execPath, [npm, 'install', '--global', '--prefix', destination,
        '--offline', '--ignore-scripts', '--engine-strict', '--no-audit', '--no-fund', '--userconfig', userConfig, '--globalconfig', globalConfig,
        '--cache', join(directory, 'cache'), '--', tarball], {
        cwd: directory, timeout: 60_000,
        env,
      }).catch(cause => { throw new Error('npm could not install the verified release. Check permissions and rerun agentswitch update.', { cause }); });
      const staging = join(directory, 'staging');
      await install(staging);
      const npmRoot = join(staging, modulesRelative);
      const candidateRoot = join(npmRoot, 'agentswitch');
      const candidate: unknown = JSON.parse(await readFile(join(candidateRoot, 'package.json'), 'utf8'));
      if (!object(candidate) || candidate.name !== 'agentswitch' || candidate.version !== update.version ||
          !object(candidate.bin) || Object.keys(candidate.bin).length !== 1 || candidate.bin.agentswitch !== 'dist/cli.js' ||
          (await readdir(npmRoot)).some(name => name !== 'agentswitch' && name !== '.package-lock.json')) {
        throw new Error('Release package metadata does not match agentswitch.');
      }
      const executable = join(candidateRoot, 'dist', 'cli.js');
      if (!(await lstat(executable)).isFile()) throw new Error('Release executable is missing.');
      await access(executable, constants.X_OK);
      await install(prefix);
      const result = JSON.parse(await readFile(metadata, 'utf8')) as { version: string };
      if (result.version !== update.version || await installationPrefix(packageRoot) !== prefix) throw new Error('npm could not verify the updated installation.');
      return `Updated agentswitch from ${installed} to ${update.version}.`;
    } finally { await rm(directory, { recursive: true, force: true }); }
  } finally { await rmdir(lock); }
}
