# Installation and prerelease checks

agentswitch requires Node.js **22.15 or later** and npm. The release targets Linux, macOS and native Windows with an attached console. CI runs the full suite and distribution checks on Linux and macOS. Windows Server 2022 x64 runs package installation, updater and native pseudoconsole tests against the Linux-built release tarball. Both lanes test exact minimum Node **22.15.0** and current **22**. Python 3 is used by the development checks. The installed CLI uses Node and the platform's console utilities.

The npm package is currently unpublished. These steps prepare and test a local prerelease; they do not publish, log in to npm or use publishing credentials. Provider installation and authentication remain separate. Offline package checks use synthetic data and do not certify real provider consumption.

## Install a verified tarball

Download the tarball and its matching `SHA256SUMS` from the same [GitHub release](https://github.com/rammicz/agentswitch/releases) or successful CI matrix artifact. Verify the checksum before installation using `sha256sum -c SHA256SUMS` on Linux or `shasum -a 256 -c SHA256SUMS` on macOS. Use the exact verified tarball in the install command.

```sh
npm install --global --offline --ignore-scripts --no-audit --no-fund /absolute/path/agentswitch-0.1.0-dev.4.tgz
agentswitch --help
agentswitch --version
cd your-project
agentswitch
```

On Linux and macOS, put `$(npm prefix --global)/bin` on `PATH`. Use an npm prefix writable by your user. The tarball includes compiled JavaScript and has zero runtime npm dependencies. Installation runs offline. Run `agentswitch` in an interactive terminal to open the local picker, or run `agentswitch --demo` to use synthetic sessions.

On Windows, open PowerShell in your download folder and run:

```powershell
$sum = (Get-Content .\SHA256SUMS -Raw).Trim().Split(' ')[0]
if ((Get-FileHash .\agentswitch-0.1.0-dev.4.tgz -Algorithm SHA256).Hash -ne $sum) { throw 'Checksum mismatch' }
npm.cmd install --global --offline --ignore-scripts --no-audit --no-fund .\agentswitch-0.1.0-dev.4.tgz
agentswitch.cmd --version
agentswitch.cmd
```

On Windows, add the directory printed by `npm.cmd prefix --global` to your user `PATH` if the command is unavailable. Use `agentswitch.cmd` in PowerShell when execution policy restricts npm's PowerShell shim. Install each provider's compatible Windows executable separately. The launcher recognizes native EXEs and the supported npm shims for Codex, Claude Code, and OpenCode. The Codex receipt hook is available on Linux and macOS. Windows keeps delivery status uncertain after launch.

Windows stores application data under `%LOCALAPPDATA%\agentswitch` by default and inherits that folder's Windows access controls. Use a directory private to your account if you override the state location.

Remove the installed command with:

```sh
npm uninstall --global --offline --ignore-scripts --no-audit --no-fund agentswitch
```

Uninstall removes the npm package and command. Native histories and agentswitch's separately stored search cache, archives and delivery journal are user data and remain on disk; see [integration and explicit retention controls](integration.md). For the source-development `npm link` described in the README, the same global uninstall removes that link.

## Update an installed copy

The interactive picker checks public GitHub release metadata once per UTC day and displays a notice in the session list. The check runs alongside the picker and times out after two seconds. Set `AGENTSWITCH_NO_UPDATE_CHECK=1` to disable startup checks. The demo and source checkouts run without startup checks.

```sh
agentswitch update
```

The command checks immediately and installs the newest eligible release into the same writable global npm prefix. It verifies the package against the GitHub asset SHA-256 digest and validates it in a temporary installation before updating the installed copy. npm runs offline with package lifecycle scripts disabled. Prerelease installations can move to newer prereleases or stable releases. Stable installations stay on stable releases. For a source checkout or `npm link`, update the checkout and rebuild.

For an authorized GitHub release, use a tag matching the package version with a leading `v`, such as `v0.1.0-dev.4`. Attach the exact verified `agentswitch-<version>.tgz` under that name and mark prerelease versions as prereleases. GitHub supplies the asset digest that the updater checks. GitHub Actions workflow artifacts continue to support manual installation.

## Candidate checklist

1. Choose an exact commit with a clean checkout (`git status --porcelain` must be empty). Update `package.json` and both root versions in `package-lock.json` together when changing the release version. `--version` reads the installed package metadata. Keep prerelease versions until a release is explicitly approved.
2. On Linux and macOS, use Node 22.15.0 and current Node 22. Run the following from that candidate checkout. `npm ci` provisions development dependencies and may access the registry; the subsequent distribution install is strictly offline with an empty npm cache and isolated configuration.

   ```sh
   npm ci
   npm run check
   npm test
   npm pack --dry-run
   npm run distribution:check
   ```

3. The last command prints a new artifact directory outside the checkout. For a chosen destination, use `npm run distribution:check -- --output /absolute/path/to/new-artifact-directory`; its parent must exist and the destination must not exist. Review `result.json`: require `passed: true`, `sourceDirty: false`, the intended `sourceCommit` and version, and `disposableStorageRemoved: true`. Check the checksum and manifest against the retained tarball. Source metadata and lockfile versions must match the archived metadata and installed CLI output.
4. Require every CI job to succeed for that exact source commit. Linux and macOS run type checks, full tests, pack dry-run, and distribution checks. Both Windows jobs verify the digest and install the actual minimum-Node Linux artifact, then check the updater and terminal handoff. The Linux and macOS artifacts are retained for 14 days. Their names include the commit, operating system, Node version, and workflow attempt.
5. Retain the exact verified tarball, `pack.json` (npm manifest), `archive.json` (actual tar entries and package metadata), `SHA256SUMS` and `result.json` (version, digests, source commit, environment versions and smoke outcomes). Transfer these together to controlled release storage if retention must exceed 14 days. Any later authorized distribution must use the tested tarball rather than repacking a changed checkout. Publishing and tag pushes require separate authorization.

The checker builds through `prepack`, then independently inspects the actual gzip tar without extracting it. It compares every path and file size to npm's manifest and the tracked runtime/documentation allowlist; rejects links, traversal, duplicates and forbidden native-history/credential/machine-data paths; and checks npm integrity plus SHA-256. Compiled `.js`, `.d.ts` and `.js.map` files and the bundled third-party license are intentional. Path checks and review of the clean candidate establish the inclusion boundary; they cannot detect an arbitrary secret embedded in otherwise legitimate source or documentation.

It installs that exact tarball under a disposable prefix with spaces, an empty home, private synthetic native/state roots, empty npm configuration and a new cache. It verifies the real bin link, executable permissions and `PATH` resolution; runs installed help/version, invalid flags, piped picker modes, transfer listing/cache purge and synthetic archive paging/deletion; then explicitly uninstalls offline. Removal must leave no installed package or bin link, direct execution must fail with `ENOENT`, and an unrelated prefix sentinel must survive. Temporary home, native roots, prefix, npm storage and synthetic state are removed even after a failed assertion. Only the five listed release files are retained, never `.npmrc`, environment dumps, histories, credentials or generated handoff/journal state.

Temporary roots are canonicalized before checking installed paths, including macOS `/var` aliases. Python 3 is resolved from the invoking `PATH` to an absolute executable before child environments are isolated, so a Homebrew installation can be selected. The checker invokes the installed executable directly and through `PATH` with the selected Node binary first; it does not use `npx`, source-directory links, a globally installed agentswitch or a warm npm cache. The checker may be run during development, but a result with `sourceDirty: true` is not a release candidate.
