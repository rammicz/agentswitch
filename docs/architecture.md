# Architecture and first-release decisions

## Boundaries

The CLI coordinates a session catalog, query service, terminal UI, continuation planner, handoff builder, delivery journal, and provider adapters. The scaffold implements only shared types, synthetic search and an interaction prototype. Adapter implementations, persistence and launch are deliberately pending.

TypeScript on Node 22+ keeps installation straightforward for CLI users while allowing native subprocess launch. Avoid runtime dependencies until a concrete feature warrants them.

## Catalog and search

Adapter reads must be non-destructive. Discover configured native roots, including environment overrides; identify session IDs, source workspace, timestamps and searchable public text. Malformed records should yield bounded diagnostics without hiding healthy sessions. Never index credentials or hidden reasoning. Separate metadata discovery from lazy transcript reads and a rebuildable persistent full-text index.

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
