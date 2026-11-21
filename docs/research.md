# Research provenance

The user supplied `agentswitch-research`, a static investigation of T3 Code retrieved on 2026-11-21 at commit `755de001f25c54c9d6435bb23a83ffcd231e06a5`. It inspected source and existing upstream test cases; it did not run provider calls or establish installed application behavior. This repository retains conclusions and immutable public source references, not the research checkout or private transcripts.

## Findings used in the design

- Keep canonical application history separate from native provider contexts: [transition policy](https://github.com/pingdotgg/t3code/blob/755de001f25c54c9d6435bb23a83ffcd231e06a5/apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts).
- Select intact public messages deterministically, budget final serialization, and retain omission references: [handoff budget](https://github.com/pingdotgg/t3code/blob/755de001f25c54c9d6435bb23a83ffcd231e06a5/packages/provider-core/src/server/handoffBudget.ts).
- Keep delivery intent separate from actual acceptance; ambiguous transport failures must not cause blind replay: [delivery service](https://github.com/pingdotgg/t3code/blob/755de001f25c54c9d6435bb23a83ffcd231e06a5/apps/server/src/orchestration-v2/ContextHandoffDelivery.ts).
- Native import is adapter-specific and requires explicit capability handling: [adapter contract](https://github.com/pingdotgg/t3code/blob/755de001f25c54c9d6435bb23a83ffcd231e06a5/packages/provider-core/src/server/ProviderAdapter.ts).

These findings inform agentswitch; they are not proof that every target CLI exposes those APIs. Start with fresh-session attributed history before advanced resume-with-deltas or native import.

## Local CLI evidence

During scaffolding, local `codex --help` exposed `resume` and an initial prompt; local `claude --help` exposed `--resume` and an initial prompt. Only help was run: no provider session was created and no account history was read. This is evidence of possible launch paths, not a tested handoff transport. Implementations must capture supported versions, sanitized file-format fixtures, and input-size/interactive behavior before claiming support. Current CLI flags and native session layouts are version-dependent.

No T3 source implementation was copied. If future work copies upstream code, retain its applicable MIT notice.

## Claude native history evidence

The read-only Claude reader follows the official [Python Agent SDK native session reader](https://github.com/anthropics/claude-agent-sdk-python/blob/3184360393a92ca8a6ec7bbbdee571afd1ce1c56/src/claude_agent_sdk/_internal/sessions.py#L122) at revision `3184360393a92ca8a6ec7bbbdee571afd1ce1c56` (SDK 0.2.187, bundled CLI 2.1.330). The [active graph and compaction policy](https://github.com/anthropics/claude-agent-sdk-python/blob/3184360393a92ca8a6ec7bbbdee571afd1ce1c56/src/claude_agent_sdk/_internal/sessions.py#L931), [parallel tool recovery](https://github.com/anthropics/claude-agent-sdk-python/blob/3184360393a92ca8a6ec7bbbdee571afd1ce1c56/src/claude_agent_sdk/_internal/sessions.py#L1086) and [native-shaped tests](https://github.com/anthropics/claude-agent-sdk-python/blob/3184360393a92ca8a6ec7bbbdee571afd1ce1c56/tests/test_sessions.py#L682) provide format evidence independently of CLI help. Fixtures are source-derived synthetic data; no personal transcript or provider call produced them. Optional producer versions are evidence, not a required schema header. See [the implemented reader's policy and limits](claude-reader.md). The upstream MIT notice is retained in [claude-sdk-license.txt](claude-sdk-license.txt).

## OpenCode native history and launch evidence

The [1.19.6 compatibility profile](opencode-reader.md) records dated distribution, platform and MIT evidence from official `opencode-ai@1.19.6` and commit `f4e363c8295fa90a03dddc451882fffe8fbce357`. Its implemented public reader uses `session/message/part`, immutable no-sidecar reads and explicit roots. Exact native `ses_` resume omits all initial prompts; fresh transport uses the complete bounded `--prompt=` envelope. Four-direction default-CLI PTYs use synthetic databases and fake providers. Source evidence, fake runtime checks and unverified actual provider behavior are distinguished in that profile. Version 2.3.2 is separately inspected and unsupported.

## Grok Build public schema and native build evidence

The [Grok Build profile](grok-reader.md) separates public Apache-2.0 source snapshot `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8` (Cargo 1.0.45, upstream SOURCE_REV `559751fdcec02d413e4c57c8832ab275e4f44980`) from the official versioned Linux x86_64 binary, whose actual version is `grok 1.0.45 (c33bff361a6f)`. Public v1 session fixtures follow the source schema; the binary was run only for version/help in a sterile, no-network sandbox. Different revisions are retained explicitly: there is no verified source-to-binary equivalence or real provider consumption claim. Four-direction offline default-CLI PTYs use synthetic files and fake runtimes. No upstream code or native binary is distributed in this package.
