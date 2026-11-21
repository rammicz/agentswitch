# Project instructions

## Scope and product

This is an early scaffold. Read README.md and docs/architecture.md before implementation. Preserve the distinction between demo behavior and working provider integration. Never edit native agent history to manufacture cross-provider sessions. Never copy credentials or bypass native permissions.

## Development queue and ownership

- Actionable development issues use `queue:dev`. Select only open, ready tasks in that queue by default; exclude epics, deferred work, unresolved blockers and another active session's claims.
- Record role/session ownership in an issue comment before implementation. Include session identifier, scope, branch and starting commit. An assignee alone is not ownership. Check recent comments before claiming; do not take over an active claim without an explicit handoff.
- Use `status:ready`, `status:in-progress`, `status:triage`, `status:deferred`, and `status:blocked` consistently. Priorities are `priority: P1` for first-release outcomes and `priority: P2` for later work. Use `enhancement` for planned features.
- `status:blocked` requires concrete open prerequisite issues in both native GitHub blocked-by relationships and a Dependencies section. Check cycles and read back links. Once every prerequisite resolves, return to `status:ready`. Shared contracts and suggested ordering alone are soft sequencing, not blockers.
- Local verification belongs to the same development issue. Do not create separate QA tasks per fix. Queue labels grant no credentials or access.
- Record implementation, checks and remaining limits on the issue. Verify release/deployed behavior when relevant before closure. Do not reset, rebase, amend or push another session's unfinished work.

## Checks and data

Run `npm run check` and `npm test` for code changes; validate `npm pack --dry-run` for distribution changes. Use fixture-based parser tests, PTY tests for terminal lifecycle, and fake executables for launches. Real provider/model calls are opt-in. Never commit local histories, account data, `.env` files or generated handoff artifacts.
