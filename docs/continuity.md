# Continuity and accepted coverage

The default picker can return from a Claude Code conversation to an earlier
Codex context in the same application lineage. Its summary separates selected
history source from actual native target. It sends the eligible activity missing
from that target, then the separate current request. Deterministic whole-item
selection, the 16,384-byte budget and approved omission archives still apply.
Ordinary same-agent selection keeps current-request-only native resume.

This conditional integration is verified offline with provider-shaped fake
executables. No live provider, account or real-history test has been run.

## Identity and provenance

Context identity includes provider, canonical configured-root digest, exact UUID
and the selected file's device/inode/birthtime incarnation. Stable activity IDs
include native item identity and a public role/status/text revision digest.
Repeated equal text with different IDs remains distinct. Canonical items carry
provider and non-sensitive context attribution.

An exact native user-message echo can connect a source to a known launched
attempt. Its immutable full-prompt hash, unique archive nonce, target provider
and root must match. Only that attempt supplies aliases to original IDs and its
separate request. Arbitrary JSON-looking text is ordinary history. An echo proves
provenance, never consumption. Deleted known payloads are not reimported as new
activities.

New private SQLite tables contain metadata/hashes/sets only. Public text remains
in native histories or the existing approved redacted prompts/archives. Schema
v1 outcomes migrate unchanged; legacy acceptance invents no lineage coverage.

## Conditional Codex receipt

Codex advertising `--config <key=value>` (tested with **0.171.0**) receives launch-local
`hooks.UserPromptSubmit` and `hooks.Stop` declarations. Native layer discovery
adds them alongside existing callback layers. No saved settings, notify handlers,
feature flags, permissions, trust hashes or credentials are written/replaced.
Native enablement, trust and managed policy determine whether hooks run. Review
native trust prompts normally; agentswitch never approves them for you.

The stable command uses safely quoted absolute installed Node/helper paths.
An ephemeral child-only environment locator binds private journal, attempt and
nonce; other/unsupported launches scrub it. The silent helper bounds input to
64 KiB and four seconds, emits no model context and stores only correlation
metadata. It stats the native transcript for incarnation and reads no content.

Exact submitted prompt hash binds the actual main native session and turn.
Submit alone changes no coverage. Matching successful main Stop establishes
consumption. Subagent/failed/unmatched turns, wrong root/incarnation, conflicting
submits, absent hooks, exit zero, stdout, PTY ACKs and retired/deleting attempts
cannot accept. The pinned
[submit contract](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/hooks/src/events/user_prompt_submit.rs)
and [Stop after successful sampling](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/core/src/session/turn.rs#L833)
support this adapter. It trusts the configured native provider and callbacks
under the same OS user; it is not attestation against arbitrary same-user code.

Acceptance atomically commits actual identity, turn and exact selected coverage
in one FULL transaction. Omitted IDs remain missing. Identical callbacks are
idempotent. Receipt never releases writer admission or archive pins.

After supervised native close, while its writer reservation is still held, a
separate metadata transaction can certify the completed native branch. It
requires the unchanged pre-turn prefix and exactly one immutable prompt echo
followed by complete assistant/tool outputs. Every appended public item must
have the accepted main session/turn IDs from paginated `item_completed` records;
another user input, unrelated turn, changed prefix, compaction or missing turn
metadata refuses certification. Exact subsequent branch validation remains in
force. Thus a second return to the accepted target sends only newly missing IDs,
including an empty history when that target has missed nothing.

The checkpoint adds hashes and canonical IDs for the native assistant/tool
activity, without changing imported accepted coverage. It retains no new raw
output text. Later preparation reads those known IDs from the still-matching
native prefix for exact preview and consent. Unrelated later growth can supply
neither new eligible activity nor native reuse; a fresh rebuild may include the
already certified prefix. Missing certified output requires restored native
history or explicit F recovery. Legacy layouts without this paginated turn
evidence, incomplete flushes and interactive sessions with additional user turns
remain conservative fresh fallbacks. Ordinary selected-source native resume is
still available under its existing compatibility checks. Codex and Claude contexts
from untested but well-formed producer versions are retained and reusable like tested ones.

Claude Code has no implemented exact-turn receipt adapter. Its Stop lacks the
correlation proven for this Codex surface. Cross-provider Claude selection uses
a newly reviewed fresh bounded context and keeps uncertainty. Offline fake
events do not establish Claude acceptance support.

## Reuse and recovery

An earlier target must still have the exact observed active public branch,
incarnation, workspace and supported retained-context shape. Missing/replaced
targets, unobserved growth, compaction, unsupported receipt transport or unknown
ownership select a fresh bounded rebuild with an explanation before consent.
Selecting a target later as source can observe legitimate new activity. External
native writers remain outside application admission control.

Rollback excludes changed/removed activity and its causal suffix before budget
selection. Excluded IDs stay excluded later. An earlier context retaining them
cannot be repaired with a delta and is not reused. Coverage is a set, never a
high-water cursor. Independent sources choosing the same target atomically
reserve its actual scoped identity. Wrapper death, even without a saved child
PID, retains unknown reservations; nothing is automatically replayed or stolen.

F selects a new native target and retains the eligible lineage when its archives
are available. Creating a new target does not itself invalidate source activity.
If required ancestry was deleted or is unreadable, F instead offers an explicitly
disclosed active-source recovery: available native activity and known included
echo items, excluding unavailable application ancestry and earlier native reuse.
The exact narrowed payload requires final confirmation. Ordinary preparation
fails clearly on unreadable required ancestry. Removed/compacted native branches
never return through archives. There is no verified structured exhaustion
signal: select F and review a new payload. Generic stderr/exit codes never
trigger a second dispatch.

History redactions require a new continuity target because they cannot erase
existing native context. Ordinary native resume redacts its new request only
and discloses retained native history. Transfer deletion invalidates linked
lineage reuse and refuses while any linked writer is unknown. Direct archive
deletion remains explicit and may require F recovery later. Native data and the
separate searchable cache retain their existing deletion controls.
