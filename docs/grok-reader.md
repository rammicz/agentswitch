# Grok Build pinned public profile

Grok Build is xAI's terminal coding agent, installed as `grok` (source/filter ID `grok`). The requested name “grokbuild” identifies this product. The picker reads its public history, searches normalized text and offers reviewed incoming/outgoing fresh handoffs. Native reuse requires an exact discovered UUID, recorded canonical workspace, explicitly empty draft and final confirmation. Actual provider consumption remains unknown.

## Evidence, dated 2026-11-21

| Evidence | Observed identity | What it establishes |
| --- | --- | --- |
| [Official public source](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8) | Export `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`, upstream [SOURCE_REV](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/SOURCE_REV) `559751fdcec02d413e4c57c8832ab275e4f44980`; [Cargo](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-bin/Cargo.toml) 1.0.45 | Source schema and documented static launch policy; no native execution |
| [Official versioned Linux x86_64 binary](https://x.ai/cli/grok-1.0.45-linux-x86_64) | 170448832 bytes; generation `1790661872193104`; MD5 `b00a4b30baf05eb1b58731552bd7d01c`; locally computed SHA-256 `3ef9bf5689ae9cc58f1bc918ae6067627a3667c7519245b9e8aacd9288559718` | HTTPS artifact identity/integrity observations; MD5 metadata is not a publisher signature |
| Real isolated `--version` | `grok 1.0.45 (c33bff361a6f)` | Exact supported native build string. Revision differs from both public-source revisions; source-to-binary equivalence is unknown |
| Real isolated `--help`, and `--cwd=/tmp --resume=11111111-1111-4111-8111-111111111111 --help` | Exit 0; `Usage: grok [OPTIONS] [PROMPT] [COMMAND]`, interactive `[PROMPT]`, `--cwd <CWD>`, `--resume [<SESSION_ID_OR_TITLE>]` | Advertised argument surface and equals-form parser acceptance; no resume, model turn or authenticated session was run |
| [Official source README](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/README.md), [license](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/LICENSE) | Apache-2.0 public source; advertised macOS Intel/ARM, Linux x86_64/ARM and Windows/WSL | This package copies no upstream implementation/binary. Native accounts, credits and service terms remain independent |
| [Official stable pointer](https://x.ai/cli/stable) | Separately observed 1.0.92 | Outside this pin; not evidence that newer storage or flags are compatible |

agentswitch targets Linux/macOS. The real binary probe above ran on Linux x86_64 only. macOS native binaries and Windows have not been probed. Offline CI uses fake targets and cannot certify native provider behavior or permission handling.

The real probes ran under `bwrap --unshare-all --die-with-parent --new-session`, a read-only `/usr`, temporary `/tmp`, empty environment, scratch HOME/GROK_HOME/cwd, no user/workspace/config mounts, and a 20 second wall timeout, 10 second CPU limit, 2 GiB address-space limit and 1 MiB file-size limit. Only the versioned binary was mounted read-only. The installer was never executed. Retained sanitized outputs are `test/fixtures/grok/{version,help,parse-help}.json`. Default tests never run this binary. To reproduce parser/fake-terminal checks:

```sh
npm run build
node --test test/grok-adapter.test.mjs test/grok-runtime.test.mjs test/grok-integration.test.mjs
```

## Read-only storage policy

`new GrokSessionAdapter({root, home, env, limits, onDiagnostic})` uses explicit `root`, otherwise nonempty `GROK_HOME` verbatim, otherwise `~/.grok`. Whitespace in a configured path is preserved. Missing roots are never created. Root aliases resolve canonically; symlinks beneath the root are refused. Application state cannot overlap this root, its ancestors, aliases or missing descendants.

The pinned source defines `sessions/<cwd-bucket>/<UUID>/{summary.json,chat_history.jsonl,updates.jsonl}`. Buckets are opaque: native encoding, long-path hashes and `.cwd` marker names never supply workspace identity. Only validated `summary.info.cwd` and matching exact folder/`summary.info.id` supply the canonical source workspace and UUID. Discovery reads summaries only and returns empty message arrays; catalog hydration reuses one discovery generation and selected revalidation rescans authoritative metadata. No native command, database, lock, `.cwd`, updates, settings, credentials or repair helper is used. Native list/load/export helpers can heal or lock storage and are deliberately avoided.

The initial profile accepts quiescent local top-level `chat_format_version: 1` summaries with valid creation/update dates and public title (`generated_title`, otherwise `session_summary`). Recency prefers `last_active_at`, then `updated_at`. Hidden rows are excluded. Session-kind/worktree, relocation generation/previous/pending cwd, display/source-workspace overrides, legacy format 0, missing format and future versions are unsupported. Recursive legacy layouts are not inferred. Duplicate UUIDs across buckets fail closed. A hashed cwd bucket itself is supported because its name is never interpreted. Source workspace aliases canonicalize without rewriting metadata; missing folders require an explicit valid override for fresh mode.

Fixtures derive from pinned [Summary](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/persistence.rs) and [ConversationItem](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sampling-types/src/conversation.rs). File order is chronological. Whitelisted human text parts, assistant string content and public tool-result string content become normalized messages. The first unmarked human before prompt markers is the native preamble; unmarked human followups after markers can be runtime injections and are omitted. Explicit non-human synthetic reasons, system items, reasoning, encrypted state, old assistant reasoning, raw tool arguments, auth and unknown metadata fields are never projected. Parent/agent/interjection and other synthetic-origin rows are conservatively omitted. Image attachments, backend tool-call records and unknown public variants make selected history incomplete, rather than certifying a silent partial transfer. No claim is made that arbitrary secrets typed as public conversation text can be detected; use the explicit redaction preview.

Repeated identical public items retain distinct ordinal/content IDs, stable under same-file append. Session identity includes root, UUID and recorded creation time. Rewrites change the selected fingerprint; no prefix/receipt/continuity coverage is inferred (`retained:false`). Files are read with no-follow, canonical containment, byte limits and before/after identity checks; a changed summary invalidates its history snapshot. Defaults: 10000 directory entries, 32 MiB history, 1 MiB metadata/line, 256 MiB generation read budget, 100000 records and 100 diagnostics. Limits can only decrease. Invalid UTF-8, partial tails, malformed records and unavailable reads receive bounded content-free diagnostics. Healthy siblings refresh; degraded scans retain prior cached search entries, which cannot transfer without fresh validation. The cache can be explicitly purged.

This is a schema-detected source profile, independent from the native binary version. Real authenticated storage writing, compaction/relocation and a source-to-binary revision map have not been validated.

## Interactive launch and recovery

Help is probed during preparation; any version/build whose help lists `--cwd`, plus `--resume` for native open, is accepted (tested with `grok 1.0.45 (c33bff361a6f)`). Missing executables or required flags fail before publication. Fresh transport is exactly:

```text
grok --cwd=<selectedCanonicalWorkspace> -- <completeSerializedHandoffJson>
```

The JSON is one literal argv element, bounded to 16384 UTF-8 bytes including attribution, historical items, omission retrieval and distinct current request. It uses inherited stdin/stdout/stderr, `shell:false` and that canonical cwd. No headless `-p`, file/stdin/ACP transport or system-prompt injection is added. No permission, trust, sandbox, terminal policy, model, authentication or restore-code flags are added; native configuration remains inherited.

Native reuse is exactly `['--cwd='+recordedCanonicalWorkspace, '--resume='+exactUUID]`. The draft must be explicitly cleared; select F to retain a request through a fresh reviewed envelope. Workspace override forces fresh mode. No latest/title/prefix/fork/remote restore or new-session-ID fallback is allowed. Pinned [startup source](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/session_startup.rs) requires an existing UUID and disables implicit remote restoration, but the differing released build's deletion race behavior has not been executed. A missing session discovered before dispatch refuses locally. Native reuse sends no automatic prompt even if the target's subsequent availability changes.

Four-direction Codex/Claude↔Grok PTYs exercise the actual picker, catalog, redaction, bounded archive/journal, workspace choice, terminal input/restoration, status/signals and recovery with synthetic files and fake providers. Native empty-request, incompatible profile, cancellation, omissions, changed source and a crashed wrapper retaining one live owned fake PID are covered. Installed-package checks repeat all four directions and native reuse. These certify agentswitch behavior only. Exit, PID and fake acknowledgment are never a provider receipt. Grok actual target identity and consumption remain unknown, accepted coverage never advances, and uncertain delivery is never replayed automatically. Existing Codex-only continuity receipt support is unchanged.
