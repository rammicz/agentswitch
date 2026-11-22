# Antigravity 1.5.14 synthetic replay evidence

On 2026-11-22, the exact Linux x64 Antigravity CLI **1.5.14**, verified against the publisher's SHA-512, completed owned synthetic turns against a loopback mock in a private network namespace. No Google account, genuine API key, personal session, installed agy, external model or native permission bypass was used. This evidence supplies [issue #14](https://github.com/rammicz/agentswitch/issues/14)'s prerequisite for [issue #9](https://github.com/rammicz/agentswitch/issues/9). The shipped [limited agy profile](agy-reader.md) remains unchanged.

## Retained evidence

[`test/fixtures/agy/replay/evidence.json`](../test/fixtures/agy/replay/evidence.json) contains reduced native metadata and public protocol anchors from the actual native runtime. The referenced `.jsonl` files retain the observed native record layout with explicit exclusion markers. The separate `initialize.json` and `unauthenticated-list.json` fixtures describe the earlier sterile unauthenticated probe.

| Route | Observed result | Boundary |
| --- | --- | --- |
| ACP synthetic turn | `initialize` reports 1.5.14 and protocol v1; native `session/new` and `session/prompt` complete | Synthetic API-key authentication against a private loopback endpoint only |
| Second ACP process | Workspace/global lists identify the same native UUID; `session/load` emits the user then assistant public text and returns successfully | Thought chunks and usage updates are separate non-public updates; no model-generation call or client callback during selected load |
| Native `--print` | Two sessions have explicit, distinct `file:///work-one` and `file:///work-two` summary workspace URIs; both persist public text and a separate `thinking` field | One controlled user request includes nested closing delimiters; extracting through the first closing tag would truncate genuine user text |
| Native interactive prompt | Generated user/assistant records and last-ID cache agree on UUID | Summary `workspace_uris` is empty; disk evidence only, bounded termination, no terminal consumption claim |
| Native local file tool | A synthetic `read_file` turn generated user, tool-call carrier, `GENERIC` result and final assistant records | Arguments, raw result and thinking are excluded; tool-result public visibility remains unverified |
| Independent file read | Named summary columns and generated transcript files were read without changing their contents, sizes or modification times | SQLite `mode=ro&immutable=1` after rejecting summary WAL/SHM sidecars; access times are outside the comparison |

The fresh one-session ACP workspace and global lists had no next cursor. Multi-page pagination, inventory across projects/accounts and large replay behavior remain unverified. A separate `session/load` for a valid synthetic UUID absent from the catalog returned success with zero updates and zero model calls. Successful load therefore needs independent identity and completeness validation. The known-session completion anchor is the response to the selected `session/load` after both observed public chunks; its scope is this captured two-message replay.

The fixture retains synthetic native UUIDs consistently across catalog, list, cache and log path. An item can be identified as that UUID plus the observed `step_index` within this captured snapshot. Timestamps are normalized to valid native forms, `2026-01-01T00:00:00Z` in JSONL and `2026-01-01 00:00:00.000000000+00:00` in summary rows. Rewind, deletion, rewrite and identity stability across later native changes remain unverified. Producer-version attestation is absent from these summary/log bytes. Compatibility evidence applies to the captured binary and storage shape. Exact launch-version validation is a separate check.

## Side effects and exclusions

Separate ACP initialization/list/load with the default writable synthetic profile changed `cache/conversation_metadata.json`, `cache/onboarding.json`, `conversation_summaries.db` and `jetbox_summaries_proto.pb`. Treat default ACP attachment as a native writer. No generation or permission request was observed during that selected load. The fixture records aggregate attachment changes; attribution to individual protocol requests remains unresolved.

A second case mounted the namespace root read-only for the attaching ACP process, used `--include-default-customizations=false --disable-telemetry`, and retained the original ACP owner after a completed synthetic turn. Listing found the exact session, but load succeeded with **zero updates**. Profile hashes, workspace bytes and mock-generation counts remained unchanged. The original owner then completed a second synthetic turn and exited. Read-only attachment now replayed all four public chunks in user/assistant order, again preserving profile bytes and generating no model calls. The retained harness reproduces both stages.

The [independent scout report](../test/fixtures/agy/replay-independent.json) obtained the same result with a read-only `.gemini` profile mount. Its ordinary replay preserved 62 profile files and returned two public chunks. During the open-owner case, it observed a stable two-row transcript and existing SQLite WAL/SHM sidecars. The catalog's idle status during that concurrent read was not captured. Both investigations exercise a live ACP process between completed turns; in-flight generation and native TUI ownership remain unverified.

The native public text updates are `user_message_chunk` and `agent_message_chunk` with text content. Exact-version replay also emitted `agent_thought_chunk`; repeated captures sometimes included `usage_update` before the load response. Both kinds must be excluded from public history. The fixture records the kinds actually observed in its selected replay and the public exclusion policy separately. The generated log uses `USER_EXPLICIT` / `USER_INPUT` and `MODEL` / `PLANNER_RESPONSE`, observed in increasing step order with `status: DONE`. An assistant record's `content` is distinct from its `thinking` value.

The native user record wraps the request in `<USER_REQUEST>`, then appends internal `<ADDITIONAL_METADATA>` and `<USER_SETTINGS_CHANGE>` bodies. The fixture replaces those internal bodies with `<EXCLUDED_NATIVE_METADATA>` and `<EXCLUDED_NATIVE_SETTINGS>`, replaces thinking with `<EXCLUDED_THINKING>`, and normalizes timestamps. It preserves the entire controlled request, including its adversarial nested tags. This reduction uses knowledge of the synthetic input. A general parser for the native user wrapper still requires a trustworthy boundary.

Only named summary columns are retained. `raw_summary`, conversation databases, protobuf content, native builtin/runtime files, full logs, request bodies, headers, credentials and terminal captures are excluded. The catalog SQL declaration is retained as schema evidence. The local-file case used ordinary native permissions to read a disposable synthetic file. It produced step 1 `PLANNER_RESPONSE` with `tool_calls` and no public `content`, step 2 `GENERIC` containing a raw result, and step 3 `PLANNER_RESPONSE` with public `content` and separate `thinking`. Tool arguments and the `GENERIC` body are replaced with exclusion markers. Its public-text expectation contains the user request and final assistant response; `omittedStepIndexes: [1, 2]` records the excluded carriers. Public tool-result visibility, other tools, rich content and attachments remain unverified. A future text-only projection needs an explicit omission policy and completeness disclosure. File reading executes no native tool.

## Concrete handoff to issue #9

The tested local paths, relative to `~/.gemini/antigravity-cli`, are:

```text
conversation_summaries.db
  table conversation_summaries
brain/<native-uuid>/.system_generated/logs/transcript.jsonl
cache/last_conversations.json
```

A future adapter can investigate a local file reader without starting or opening another native session. Its required refusal boundaries follow.

1. Use an explicit read root, bounded files/rows, regular leaves, contained canonical paths, validated canonical UUIDs and a coherent before/after snapshot. Never read opaque conversation databases or native configuration for credentials. Reject changed files and summary WAL/SHM sidecars before an immutable database read. Plain SQLite `mode=ro` alone created native sidecars during this investigation; it is insufficient for the promised preservation boundary. Reading a profile with sidecars needs a separately validated snapshot design.
2. Accept a single unambiguous absolute workspace URI from the catalog, or investigate a uniquely agreeing last-ID cache mapping when the catalog has none. The interactive sample establishes the need for this second association source. Refuse conflicting or multiple mappings, orphan logs and missing workspaces. Workspace inference from titles, cwd, prompt text or protobuf guesses is unsafe. A documented explicit user workspace choice would need separate policy and tests.
3. Require observed idle status, `not_fully_idle: 0`, `killed: 0`, consistent step order/counts and completed records. Treat active or changing sessions as unavailable. Two quiet reads and an idle flag establish a bounded snapshot; unrelated native clients can still write later. Open-session ACP replay can be empty even after a completed turn. Active native writers need a separately validated coordination policy.
4. Recognize reviewed public records, explicitly account for excluded tool carriers, and require a proven unambiguous user wrapper. Exclude metadata/settings/thinking independently of public content. Refuse ambiguous delimiters, unsupported types, unexplained count gaps, missing public text or incomplete steps. Keep empty and incomplete results distinct. The nested-delimiter fixture is an explicit refusal case until a trustworthy boundary exists.
5. Keep origin attribution and snapshot completeness visible. Never manufacture native history, import these fixtures into a personal profile, or equate successful process launch with consumption. This prerequisite implements no production adapter, search, native resume or outgoing transfer.

## Reproduction

Normal tests require no native runtime or network:

```sh
npm run build
node --test test/agy-evidence.test.mjs test/agy-adapter.test.mjs
```

Opt-in regeneration requires Linux x64, Python 3.10 or later, bubblewrap and an **already downloaded** official archive matching the immutable URL and SHA-512 in [`provenance.json`](../test/fixtures/agy/provenance.json). The script downloads and installs nothing. The executable is not redistributed.

```sh
python3 test/fixtures/agy/regenerate.py \
  --archive /path/to/cli_linux_x64.tar.gz \
  --output /tmp/agentswitch-agy-new-evidence
```

The output directory must not exist. The script checks the archive hash and single regular executable member, then runs it through `bwrap --unshare-all --clearenv`. Only system binaries/libraries, the capture script and that executable enter read-only; profiles and workspaces are disposable tmpfs directories. A loopback-only mock and a synthetic key are created inside the namespace. No host profile, host workspace, account socket or external network interface is carried in. The PTY case ends after persisted synthetic output, or at its time bound. Only reduced JSON/JSONL leaves the namespace. Review fresh output before replacing committed fixtures; generated UUIDs and some native metadata can differ between runs.

Real-account authentication, permissions for tools beyond the synthetic local-file case, in-flight writer safety, macOS/Windows runtimes and producers other than the pinned 1.5.14 binary remain unverified. Public history and outgoing handoffs remain unavailable in the shipped adapter until #9 implements and verifies its chosen contract.
