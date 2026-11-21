# Native picker, consent and recovery

Plain `agentswitch` now composes the read-only Codex and Claude Code adapters, private search index, reusable terminal picker, bounded history builder and interactive runtime. It requires a terminal. `--demo` remains synthetic and launches nothing. This is an early integration tested with offline fixtures and fake executables; no real provider consumption is certified.

Native roots follow `CODEX_HOME`, `CODEX_SQLITE_HOME` and `CLAUDE_CONFIG_DIR`, with the readers' usual home-directory defaults. State goes under `AGENTSWITCH_STATE_DIR`, or `$XDG_STATE_HOME/agentswitch` (default `~/.local/state/agentswitch`). Use a dedicated private directory. Native roots and application state must be separate, including aliases and missing descendant paths. State has separate `search`, `archives` and `transfers` directories. Readers never import, rewrite or delete native history, settings or credentials.

Folder scope matches the canonical workspace exactly. Tab toggles global scope; left/right filters source agents. Queries include public message text. Selected histories are reread before preparation and checked again after final consent. Missing workspaces require W and an explicit valid override. Recorded workspace is the default for a global result. No checkout or files are moved.

Each provider refresh is independent. Unavailable roots retain prior search data. In a degraded scan, healthy discovered sessions are updated and earlier entries are preserved, with a bounded warning naming the provider and diagnostic codes. A stale cached entry may be listed but cannot launch without a fresh readable source. Reduced Codex metadata and missing source workspace produce warnings without hiding healthy siblings. Selected incomplete public history blocks preparation; it is never silently certified complete. Startup batches use one discovery generation, then read only its selected files; ordinary selected-session reads retain authoritative rediscovery.

After transcript preview, choose either target. C edits the current request (Ctrl+U clears it), X adds a literal redaction, F explicitly requests a fresh context, and W overrides the workspace. Default current request is “Continue the task from this conversation.” Redactions replace matches before retained transfer content is built. Routing IDs and storage/workspace paths must stay exact; a redaction overlapping one is rejected before publication. Redactions do not erase original native history or the independently purgeable search cache.

The final scrollable preview names source, target, mode, workspace, included/omitted IDs, archive reference, target-provider disclosure and the exact serialized wire prompt. Native resume sends only the redacted new request, using the exact native UUID. Fresh handoff sends attributed historical public messages plus a separate request once, under the target's own account and permissions. Hidden reasoning, credentials and approval state do not transfer. Capability probes use only `--help`/`--version`; confirmation is required before publishing the redacted archive or launching an interactive target. Cancelled drafts remain in memory only. Executable/workspace identity changes fail safely; source changes require a new preview.

The launcher supports the pinned versions in [runtime.md](runtime.md). agentswitch neither installs nor authenticates providers. Target prompts are bounded to 16,384 UTF-8 bytes; argv is locally observable under OS rules. Whole omitted messages remain in the approved private archive, accessible through the displayed `archive list/read` commands. Native resume creates no historical archive.

## Journal and ownership

A versioned private SQLite journal uses FULL synchronous transactions and exclusive source admission. It records immutable attempt UUID, source/root digest and native identity, target provider, mode/workspace, exact consented redacted prompt and its SHA-256, archive reference, included/omitted IDs, completeness, timestamps, launch/writer evidence, exit details and actual target native ID when known. It never retains redaction selections, original drafts, provider environment, executable argv copies or hidden data. Deletion uses secure SQLite page deletion, without promising physical disk erasure.

`prepared` is consented intent, `pending` is committed before any possible spawn, `uncertain` means no trustworthy consumption receipt, and `failed` means the attempt definitely failed before dispatch. `accepted` is available only through the trusted programmatic receipt boundary, correlated to attempt UUID, payload hash, target provider and actual target session identity. Production CLI providers currently supply no such receipt. Exit 0, nonzero exit, signal, PID observation and the PTY test's termios ACK never establish consumption. No delivery lineage is advanced automatically.

Ownership is independent. Pending intent reserves its canonical source before archive publication/spawn. A normal supervised target close atomically records stopped writer evidence and releases only that attempt's source admission, leaving delivery uncertain. An intentional new selection can then proceed with a new preview and confirmation. Receipt alone cannot release a writer. Wrapper death, absent PID, aged records, parent exit, abort and restart never prove the child stopped or release an unresolved reservation. No native writer is automatically taken over, and no stored prompt is automatically launched. This coordinates agentswitch-owned writers; arbitrary external native clients and provider descendants are not universally detectable or supervised.

An archive gets a durable per-attempt use pin before launch. Direct `archive delete` also refuses pinned references. Normal supervised close releases the pin. After an ambiguous wrapper crash, the pin and native source reservation remain, including the spawn-before-PID gap. Unknown writers cannot be purged through recovery; a missing parent PID is insufficient evidence. Fresh context recovery remains possible without touching the native source. This conservative refusal can retain artifacts indefinitely after an unobservable crash.

## Explicit controls

```sh
agentswitch transfers list
agentswitch transfers show <attempt-uuid>
agentswitch transfers retry <attempt-uuid>
agentswitch transfers abort <attempt-uuid>
agentswitch transfers delete <attempt-uuid>
agentswitch cache purge
```

`list` reports state/identity/evidence without prompt content. `show` explicitly returns the consented redacted prompt for review. `retry` opens the picker on the retained redacted snapshot and current request (native-resume records have no archive, so they reread current public native history for a new review/redaction), discloses possible earlier delivery, forces a fresh target context and creates a new attempt only after renewed confirmation. It never reuses the old launch plan. A new recovery attempt has its own atomic admission; competing retries of one attempt cannot launch concurrently.

`abort` retires an attempt without changing its historical outcome, killing a target or releasing unknown ownership. `delete` is explicit and allowed only for prepared/failed or retired supervised-stopped attempts. Transactional deletion admission prevents a concurrent launch before removing the archive and journal prompt. It removes matching archive crash leftovers and retained content, invalidates retrieval and leaves a minimal non-sensitive tombstone. A crash during deletion can be completed by repeating deletion; no replay becomes available. Unknown active archives remain protected.

`cache purge` separately removes derived searchable public text. It does not delete native histories or transfer archives. File deletion cannot recall target-provider data or previously returned/in-flight archive pages, and does not promise physical erasure.

All automated integration tests use synthetic native roots and fake executables. They cover both handoff directions, same-agent resume/reuse, exact consented redaction, scope/filter/workspace behavior, cancellation, changed inputs, archive omissions/retrieval, concurrent CLI processes, wrapper crashes with a live child (including no persisted child PID), receipt correlation, journal restart and private artifact deletion. No account data, real histories or model calls are used.
