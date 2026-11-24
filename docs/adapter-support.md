# Adapter proposals and support policy

Codex and Claude Code are the first-release focus. Additional agents are considered through the [adapter proposal template](https://github.com/rammicz/agentswitch/issues/new?template=adapter-proposal.md). Complete every section, using **unknown** or **unavailable** for missing evidence. A proposal records a user need and starts compatibility triage.

## Prioritization and triage

Proposals enter this repository with `enhancement`, `queue:dev` and `status:triage`. Maintainers check for duplicates and assess the following factors together.

| Factor | Evidence to consider |
| --- | --- |
| Demand | Concrete workflows, frequency, distinct public requests and verifiable usage signals. Identify observations and estimates. Explain how popularity relates to a concrete switching workflow. |
| Compatibility | Exact product/distribution/version, official supported surfaces, read-only public history, native resume or fresh transport, normal permissions, license and requested OS/architecture. Unknown capabilities remain unknown. |
| Maintenance cost | A responsible maintainer, reproducible fixtures, release/schema churn, platform coverage, packaging burden and recurring effort to keep version probes, parsers and launches accurate. |

Record **investigate** when demand and a plausible maintainable integration surface justify bounded research, or **defer** with the missing evidence and a concrete revisit condition. Investigation establishes feasibility. Support claims require the evidence checklist below. Real demand can justify investigation even when some capabilities are missing, provided the proposed limited scope is explicit.

Use this decision record on the proposal.

```text
Decision: investigate | defer
Demand: public references, observed use and remaining uncertainty
Compatibility: exact version/platform, established surfaces and gaps
Maintenance: owner, fixture provenance, expected upkeep and gaps
Scope: capabilities to investigate and explicitly unavailable capabilities
Evidence checklist: applicable checks below, results/links or still open
Next step / revisit condition: bounded action and responsible owner if known
```

Keep `status:triage` while an owner or acceptance scope is unresolved. A concrete actionable investigation can become `status:ready`. A deferred proposal uses `status:deferred`. An investigation needs acceptance criteria and the ownership comment required by [AGENTS.md](../AGENTS.md) before implementation. Set roadmap priority separately using the repository's existing priority labels. The `status:blocked` label requires concrete open prerequisites in the issue body and native GitHub dependencies.

## Evidence required for a support claim

Define each claim by exact distribution/version, OS/architecture, capability and evidence level. A source-and-target profile needs passing discovery, public history, launch and compatibility fixtures. A limited target-only or metadata profile can be documented when its applicable checks pass, but must name unavailable history, outgoing transfer or resume capabilities explicitly. An unchecked capability stays unverified or unavailable.

Before updating README support claims, record results and fixture provenance for the following checklist.

- [ ] **Official surface.** Pin release/distribution and source/schema revisions separately, license and CLI references. Verify the selected executable's version/help surface. Reject unknown versions or missing required flags. Link each native build to evidence for its storage format.
- [ ] **Read-only discovery.** Test configured roots, stable provider-scoped IDs, recorded workspace/folder scope, malformed or changing input, safe bounded diagnostics and no native file mutation. Keep discovery free of native repair and account initialization.
- [ ] **Public history.** Use redistributable synthetic/sanitized fixtures for public user/assistant text and supported textual tool outcomes. Bound I/O and history, preserve attribution/order/identity, diagnose omissions and exclude credentials, hidden reasoning and private state. Preserve review/redaction for secrets that may appear inside ordinary public message text.
- [ ] **Native resume.** Test exact compatible session identity and workspace with normal native settings, including empty-request constraints where required. Keep unsupported resume unavailable. Preserve native history and require exact session selection. Record metadata cache, public history and consumption evidence separately.
- [ ] **Fresh transport and consent.** Test the exact bounded historical payload plus separate current request, preview/explicit consent, omissions/redaction/archive references, safe argument arrays, workspace override and inherited terminal with fake executables and PTYs. Treat historical text as data with no system authority. Never replay commands or copy credentials/trust settings.
- [ ] **Failures and permissions.** Cover missing binary/auth, unsupported capabilities, active/unknown writers, cancellation, terminal restoration, launch failure/exit and recovery. Keep native permissions and approvals. Require a trusted receipt to establish consumption. Ambiguous delivery remains uncertain.
- [ ] **Compatibility and packaging.** Record tested OS/architecture and versions, run fixture/PTY coverage plus `npm run check`, `npm test`, `npm pack --dry-run` and `npm run distribution:check` when shipped content changes. Use Node 22.15.0 and the CI platform matrix in the [prerelease checklist](releasing.md). Verify the actual installed package, documentation and license inclusion. Untested hosts stay unvalidated.
- [ ] **Honest coverage and maintenance.** Link results, known limits and the maintainer/retest plan from the profile and README. Report source-derived fixtures, real isolated version/help probes, fake PTY launches and authenticated consumption separately. Real provider tests are opt-in, require scoped authorization, and do not run on paid accounts in CI. Without a retained native result, authenticated consumption remains unverified.

Review this checklist for version/schema changes before expanding a claim. Missing evidence can leave a proposal deferred or a profile partial. Support claims require the applicable evidence above.

## Current scope stays version-specific

The linked documentation records evidence and limitations for these delivered profiles.

| Profile | Current scope and limits |
| --- | --- |
| [Codex](codex-reader.md) | 0.171.0 source-derived history fixtures; runtime accepts any version advertising the required flags. Real provider consumption remains unverified. |
| [Claude Code](claude-reader.md) | 2.1.330, derived from official Python Agent SDK 0.2.187. Public history projection and help-probed runtime have documented omissions and native consumption limits. |
| [OpenCode](opencode-reader.md) | `opencode-ai` 1.19.6 public history and offline source/target fixtures. Supports empty-request native resume in its recorded workspace and fresh reviewed transport. Actual native consumption remains unverified. |
| [Antigravity CLI](agy-reader.md) | Observed 1.5.14 quiescent local public-text shape, incoming/outgoing fresh transfers and sparse metadata/confirmed empty-request native open. Real-account and external provider consumption remain unverified. |
| [Grok Build](grok-reader.md) | Public v1 source schema is pinned; runtime tested with `grok 1.0.45 (c33bff361a6f)` and accepts any build advertising the required flags. Empty-request native open and fresh transport are offline tested. Storage equivalence and authenticated consumption remain unverified. |

The CLI targets Linux, macOS and native Windows. Each adapter keeps its own provider version, storage and native runtime limits. See [platform verification](releasing.md), [runtime constraints](runtime.md) and [integration limits](integration.md).
