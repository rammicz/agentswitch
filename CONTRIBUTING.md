# Contributing

Use Node 22.15 or later and `npm ci`, then run `npm run check` and `npm test`. Distribution changes also require `npm pack --dry-run` and `npm run distribution:check`; see the [prerelease checklist](docs/releasing.md). Keep the picker small, keyboard-first, and clear about unavailable capabilities. Match README claims to shipped behavior.

Work from an individual issue with concrete acceptance and tests. Parser changes need sanitized native-session fixtures and recorded versions. Launch and terminal behavior need fake-executable/PTY coverage. Do not commit personal histories, credentials or copies of native agent databases. Provider smoke tests are opt-in and must not run on paid accounts in CI.

Read [AGENTS.md](AGENTS.md) for queue, ownership and dependency rules. New feature requests should describe the user outcome, affected agent versions, and how to verify it.

For additional agents, complete the [adapter proposal template](https://github.com/rammicz/agentswitch/issues/new?template=adapter-proposal.md). Record exact product/distribution/version, demand, official sources, OS/architecture, sanitized public fixtures and known history/resume/fresh-launch limits; use **unknown** or **unavailable** for missing evidence. Omit personal transcripts, hidden reasoning, credentials, account data and environment dumps.

Proposals enter `queue:dev` with `status:triage`. Maintainers record an investigate or defer decision based on demand, compatibility and maintenance cost using the [support policy and acceptance checklist](docs/adapter-support.md). Investigation comes before implementation commitment. Discovery/history fixtures and safe launch/PTY checks must establish each claimed capability before support wording changes; offline tests do not certify authenticated provider consumption. Existing partial and version-scoped profiles keep their limits.
