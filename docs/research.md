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
