# Contributing

Use Node 22.15 or later and `npm ci`, then run `npm run check` and `npm test`. Distribution changes also require `npm pack --dry-run` and `npm run distribution:check`; see the [prerelease checklist](docs/releasing.md). Keep the picker small, keyboard-first, and clear about unavailable capabilities. Match README claims to shipped behavior.

Work from an individual issue with concrete acceptance and tests. Parser changes need sanitized native-session fixtures and recorded versions. Launch and terminal behavior need fake-executable/PTY coverage. Do not commit personal histories, credentials or copies of native agent databases. Provider smoke tests are opt-in and must not run on paid accounts in CI.

Read [AGENTS.md](AGENTS.md) for queue, ownership and dependency rules. New feature requests should describe the user outcome, affected agent versions, and how to verify it. Support for additional agents starts with a compatibility investigation before an implementation commitment.
