# Architecture and first-release decisions

## Boundaries

The CLI coordinates a session catalog, query service, terminal UI, continuation planner, handoff builder, delivery journal, and provider adapters. The scaffold implements shared types, synthetic search and a picker with injected asynchronous query, lazy preview and continuation preparation services. Fixture-tested read-only Codex and Claude Code adapters exist separately; CLI integration, persistence, real continuation planning and launch are pending. The default CLI still prints scaffold help; `--demo` supplies only synthetic services.

TypeScript on Node >=22.15 keeps installation straightforward for CLI users while allowing native subprocess launch. Avoid runtime dependencies until a concrete feature warrants them.

## Catalog and search

Adapter reads must be non-destructive. Discover configured native roots, including environment overrides; identify session IDs, source workspace, timestamps and searchable public text. Malformed records should yield bounded diagnostics without hiding healthy sessions. Never index credentials or hidden reasoning. Separate metadata discovery from lazy transcript reads and a rebuildable persistent full-text index. The readers return metadata with empty messages; query/index integration must hydrate public history explicitly. See [Codex reader limits](codex-reader.md) and [Claude Code reader limits](claude-reader.md).

Folder scope means an exact canonical workspace match, not descendants. Global scope means all supported local history roots for the current user, not all files on the machine or remote accounts. Production code must resolve symlinks and platform path semantics; the scaffold uses lexical absolute paths only.

Sort recent sessions first with deterministic ID tie breaking. Provider filtering and scope combine with one text query. Search must reach message content, not just session names. Preview shows matching excerpts and provenance. A reusable adapter contract permits parser, TUI and planner development against sanitized fixtures in parallel.

## Continuation

Same-agent native resume and cross-agent handoff are different plans. A compatible native source session may be resumed by its own agent. A different agent initially gets a fresh conversation with attributed history. Reusing a previously targeted session with deltas is later continuity work.

Start in the recorded source workspace by default. Show it before launch, handle deleted folders, and require an explicit choice to override it. Do not silently change an agent's trust or approval flags. Use argument arrays with shell disabled; do not put unbounded transcripts or secrets into command strings. The receiving agent must get its normal terminal and current native settings.

Build deterministic history from intact public messages and relevant textual tool outcomes. Favor the latest user, latest assistant, first user, then other recent items, emitting selected items chronologically. Budget the serialized envelope including escaped Unicode, attribution and omission references; reserve space for the current request and future work. A byte budget is a conservative heuristic, not a token guarantee. Offer a preview and explicit transfer confirmation; historical content has no system authority and commands are not replayed.

Store complete normalized source content locally for retrieval, with private permissions and deletion controls. Any artifact referenced by the target must actually remain readable. Mark omissions clearly and provide a usable archive path or retrieval command. Do not add a model-generated summarizer to the initial dependency path: quota exhaustion is a primary use case.

## Delivery and lifecycle

Prepared intent is not accepted history. Journal states distinguish prepared, pending, accepted, uncertain and failed delivery. Interactive process creation proves only launch, not model consumption; absent acknowledgment retain uncertainty. Never blindly retry an ambiguous delivery or claim exactly-once remote processing. Serialize writers per native conversation, protect active sessions, and retain recoverable source/target identity and selected/omitted item IDs.

Restore terminal state before handing stdin/stdout to the child. Propagate exit status and handle missing binaries, authentication errors, cancelled launch and interrupted transfers. Never auto-install or authenticate agents.

## Scope and verification

Initial targets are Linux and macOS. Windows needs explicit subprocess, terminal and path validation. Parsers and planners use sanitized fixtures with no paid provider calls. TUI behavior and child launch use PTY tests and fake agent executables; an optional opt-in provider smoke test documents tested versions without consuming quotas in CI. Persistent state must be tested for crash recovery and concurrent processes.

## Picker service boundary

`runPicker<Plan>` in `src/tui/app.ts` accepts the contracts in `src/tui/contracts.ts`. Query returns list metadata and attributed match excerpts, without eager transcripts. Preview receives provider/session identity and lazily returns public history items. Preparation receives that identity, the independent target choice and a workspace choice marked `source` or explicit `override`. Its result pairs an opaque plan with a summary naming source, target, `native-resume` or `fresh-handoff`, workspace and included/omitted item IDs. The UI displays the supplied summary without deriving compatibility or budgeting history.

Enter progresses from list to transcript, target and final summary. Target selection offers W to type an explicit directory override; it never silently falls back from a missing source folder. Preparation checks directory existence before calling the service. Full permission and launch-time checks remain the runtime's responsibility. Long preview and summary lines wrap and scroll with up/down. Query errors offer Ctrl+R retry; preview and preparation errors offer R retry. Retrying never dispatches a continuation.

Cancellation invalidates pending work and aborts its signal. Services may finish later, but obsolete results cannot redraw or dispatch. Setup, render and stream errors reject after cleanup; recoverable service errors remain visible until retry or cancellation. Signals and confirmation use the same idempotent cleanup. The callback receives the identical opaque plan only after raw mode, input flow, alternate screen and picker listeners have been restored. Callback rejection propagates after cleanup. The embedding caller must own the terminal while the picker is active.
