# Installation and prerelease checks

agentswitch requires Node.js **22.15 or later** and npm. Initial targets are Linux and macOS. CI tests `ubuntu-latest` and `macos-latest` with both exact minimum Node **22.15.0** and current **22**. The retained result records each runner's OS release, architecture, Node and npm versions; these moving runner labels do not certify every distribution, OS version or architecture. Windows and Node major versions above 22 need validation. Python 3 with its standard library is required for the development checks, but not for installed CLI users.

The npm package is currently unpublished. These steps prepare and test a local prerelease; they do not publish, log in to npm or use publishing credentials. Provider installation and authentication remain separate. Offline package checks use synthetic data and do not certify real provider consumption.

## Install a verified tarball

Obtain the tarball and its matching `SHA256SUMS` from the same successful CI matrix artifact, or produce them using the checklist below. Verify the checksum before installation (`sha256sum -c SHA256SUMS` on Linux or `shasum -a 256 -c SHA256SUMS` on macOS). Replace the example path with that exact verified tarball:

```sh
npm install --global --offline --ignore-scripts --no-audit --no-fund /absolute/path/agentswitch-0.1.0-dev.0.tgz
agentswitch --help
agentswitch --version
cd your-project
agentswitch
```

The global npm bin directory must be on `PATH`; on these platforms it is `$(npm prefix --global)/bin`. Use an npm prefix writable by your user. The package has no runtime npm dependencies and the tarball already contains its compiled JavaScript. Installation is offline; no provider or model is called. Default use opens the real local session picker and requires an interactive terminal. `agentswitch --demo` uses synthetic sessions; piped default, `--global` and `--demo` invocations fail with an interactive-terminal message.

Remove the installed command with:

```sh
npm uninstall --global --offline --ignore-scripts --no-audit --no-fund agentswitch
```

Uninstall removes the npm package and command. Native histories and agentswitch's separately stored search cache, archives and delivery journal are user data and remain on disk; see [integration and explicit retention controls](integration.md). For the source-development `npm link` described in the README, the same global uninstall removes that link.

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
4. Require all four CI matrix jobs to succeed for that same source commit, including type checks, the full tests, pack dry-run and actual distribution checks. Review the recorded platform versions and limitations before distributing the candidate. Each successful matrix job uploads a distinct artifact named by commit, OS, Node matrix value and workflow attempt, retained for 14 days. Failed validation prevents upload of a rejected tarball. Artifacts from separate platforms need not be byte-identical; two consecutive prepack builds within each job must produce identical bytes.
5. Retain the exact verified tarball, `pack.json` (npm manifest), `archive.json` (actual tar entries and package metadata), `SHA256SUMS` and `result.json` (version, digests, source commit, environment versions and smoke outcomes). Transfer these together to controlled release storage if retention must exceed 14 days. Any later authorized distribution must use the tested tarball rather than repacking a changed checkout. Publishing and tag pushes require separate authorization.

The checker builds through `prepack`, then independently inspects the actual gzip tar without extracting it. It compares every path and file size to npm's manifest and the tracked runtime/documentation allowlist; rejects links, traversal, duplicates and forbidden native-history/credential/machine-data paths; and checks npm integrity plus SHA-256. Compiled `.js`, `.d.ts` and `.js.map` files and the bundled third-party license are intentional. Path checks and review of the clean candidate establish the inclusion boundary; they cannot detect an arbitrary secret embedded in otherwise legitimate source or documentation.

It installs that exact tarball under a disposable prefix with spaces, an empty home, private synthetic native/state roots, empty npm configuration and a new cache. It verifies the real bin link, executable permissions and `PATH` resolution; runs installed help/version, invalid flags, piped picker modes, transfer listing/cache purge and synthetic archive paging/deletion; then explicitly uninstalls offline. Removal must leave no installed package or bin link, direct execution must fail with `ENOENT`, and an unrelated prefix sentinel must survive. Temporary home, native roots, prefix, npm storage and synthetic state are removed even after a failed assertion. Only the five listed release files are retained, never `.npmrc`, environment dumps, histories, credentials or generated handoff/journal state.

Temporary roots are canonicalized before checking installed paths, including macOS `/var` aliases. Python 3 is resolved from the invoking `PATH` to an absolute executable before child environments are isolated, so a Homebrew installation can be selected. The checker invokes the installed executable directly and through `PATH` with the selected Node binary first; it does not use `npx`, source-directory links, a globally installed agentswitch or a warm npm cache. The checker may be run during development, but a result with `sourceDirty: true` is not a release candidate.
