# Adapter proposals and support policy

Codex and Claude Code are the first-release focus. Additional agents are considered through the [adapter proposal template](https://github.com/rammicz/agentswitch/issues/new?template=adapter-proposal.md). Complete every section, using **unknown** or **unavailable** for missing evidence. A proposal records a user need; it grants no account access or implementation commitment.

## Prioritization and triage

Proposals enter this repository with `enhancement`, `queue:dev` and `status:triage`. Maintainers check for duplicates and assess these factors together:

| Factor | Evidence to consider |
| --- | --- |
| Demand | Concrete workflows, frequency, distinct public requests and verifiable usage signals. Separate observations from estimates; popularity alone does not establish a useful switching workflow. |
| Compatibility | Exact product/distribution/version, official supported surfaces, read-only public history, native resume or fresh transport, normal permissions, license and requested OS/architecture. Unknown capabilities remain unknown. |
| Maintenance cost | A responsible maintainer, reproducible fixtures, release/schema churn, platform coverage, packaging burden and recurring effort to keep version probes, parsers and launches accurate. |

Record **investigate** when demand and a plausible maintainable integration surface justify bounded research, or **defer** with the missing evidence and a concrete revisit condition. Investigation establishes feasibility; it does not mark a profile supported. Real demand can justify investigation even when some capabilities are missing, provided the proposed limited scope is explicit.

Use this decision record on the proposal:

```text
Decision: investigate | defer
Demand: public references, observed use and remaining uncertainty
Compatibility: exact version/platform, established surfaces and gaps
Maintenance: owner, fixture provenance, expected upkeep and gaps
Scope: capabilities to investigate; explicitly unavailable capabilities
Evidence checklist: applicable checks below, results/links or still open
Next step / revisit condition: bounded action and responsible owner if known
```

Keep `status:triage` while an owner or acceptance scope is unresolved; a concrete actionable investigation can become `status:ready`, and a deferred proposal uses `status:deferred`. An investigation needs acceptance criteria and the ownership comment required by [AGENTS.md](../AGENTS.md) before implementation. Set roadmap priority separately using the repository's existing priority labels. Do not mark a task blocked merely because evidence is missing; `status:blocked` requires concrete open prerequisites in the issue body and native GitHub dependencies.

## Evidence required for a support claim

Define each claim by exact distribution/version, OS/architecture, capability and evidence level. A source-and-target profile needs passing discovery, public history, launch and compatibility fixtures. A limited target-only or metadata profile can be documented when its applicable checks pass, but must name unavailable history, outgoing transfer or resume capabilities explicitly. An unchecked capability stays unverified or unavailable.

Before updating README support claims, record results and fixture provenance for this checklist:

- [ ] **Official surface:** pin release/distribution and source/schema revisions separately, license and CLI references. Verify the selected executable's version/help surface; reject unknown versions or missing required flags. Source compatibility is not proof that a different native build uses that storage format.
- [ ] **Read-only discovery:** test configured roots, stable provider-scoped IDs, recorded workspace/folder scope, malformed or changing input, safe bounded diagnostics and no native file mutation. Do not invoke a native list command that repairs history or initializes account state as if it were a read-only reader.
- [ ] **Public history:** use redistributable synthetic/sanitized fixtures for public user/assistant text and supported textual tool outcomes; bound I/O and history, preserve attribution/order/identity, diagnose omissions and exclude credentials, hidden reasoning and private state. A public-text allowlist cannot detect arbitrary secrets inside ordinary message text; preserve review/redaction.
- [ ] **Native resume:** test exact compatible session identity and workspace with normal native settings, including empty-request constraints where required. Reject unsupported resume rather than inventing a session, editing native history or falling back to the latest session. A metadata cache is not public history or a consumption receipt.
- [ ] **Fresh transport and consent:** test the exact bounded historical payload plus separate current request, preview/explicit consent, omissions/redaction/archive references, safe argument arrays, workspace override and inherited terminal with fake executables and PTYs. Historical text has no system authority; never replay commands or copy credentials/trust settings.
- [ ] **Failures and permissions:** cover missing binary/auth, unsupported capabilities, active/unknown writers, cancellation, terminal restoration, launch failure/exit and recovery. Keep native permissions and approvals. Process creation or exit alone does not prove consumption; ambiguous delivery remains uncertain.
- [ ] **Compatibility and packaging:** record tested OS/architecture and versions, run fixture/PTY coverage plus `npm run check`, `npm test`, `npm pack --dry-run` and `npm run distribution:check` when shipped content changes. Use Node 22.15.0 and the CI platform matrix in the [prerelease checklist](releasing.md); verify the actual installed package, documentation and license inclusion. Untested hosts stay unvalidated.
- [ ] **Honest coverage and maintenance:** link results, known limits and the maintainer/retest plan from the profile and README. Report source-derived fixtures, real isolated version/help probes, fake PTY launches and authenticated consumption separately. Real provider tests are opt-in, require scoped authorization, and do not run on paid accounts in CI. Without a retained native result, authenticated consumption remains unverified.

Review this checklist for version/schema changes before expanding a claim. Missing evidence can leave a proposal deferred or a profile partial; the roadmap alone never establishes support.

## Current scope stays version-specific

The proposal process does not expand these delivered profiles. Their linked documentation is the detailed evidence and limitations record.

| Profile | Current scope and limits |
| --- | --- |
| [Codex](codex-reader.md) | 0.171.0 source-derived history fixtures and pinned runtime surface; fixture compatibility does not certify real provider consumption. |
| [Claude Code](claude-reader.md) | 2.1.330, derived from official Python Agent SDK 0.2.187; public history projection and pinned runtime, with omissions and native consumption limits documented. |
| [OpenCode](opencode-reader.md) | `opencode-ai` 1.19.6 public history and offline source/target fixtures; empty-request native resume in its recorded workspace, fresh reviewed transport. Actual native consumption remains unverified. |
| [Antigravity CLI](agy-reader.md) | 1.5.14 partial profile: incoming fresh transfers and sparse metadata/confirmed empty-request native open; public history and outgoing transfers remain unavailable. It is not a supported source-and-target history profile. |
| [Grok Build](grok-reader.md) | Public v1 source schema and `grok 1.0.45 (c33bff361a6f)` runtime build are independently pinned; empty-request native open and fresh transport are offline tested. Storage equivalence and authenticated consumption remain unverified. |

Linux and macOS are the initial agentswitch platforms; a provider offering another build does not certify agentswitch on that host. Windows needs validation. See [runtime constraints](runtime.md), [architecture](architecture.md) and [integration limits](integration.md).
