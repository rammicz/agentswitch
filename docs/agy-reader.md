# Antigravity CLI: target and sparse metadata profile

Google Antigravity CLI (`agy`) **1.5.14** has a limited integration. Codex, Claude Code and OpenCode public histories can be transferred into a reviewed fresh agy session. The picker also reads the documented local last-conversation cache and can open one exact native conversation without submitting a request. Full agy public-history search and outgoing transfers remain unavailable. A cache with no public items is never certified as an empty transcript.

## Local metadata and native open

The reader reads only `~/.gemini/antigravity-cli/cache/last_conversations.json`. This JSON object maps absolute workspace paths to last conversation IDs, as described in Google's [resume documentation](https://antigravity.google/docs/cli/commands/resume). `AGENTSWITCH_AGY_ROOT` overrides the `antigravity-cli` directory for agentswitch. The programmatic `root` option takes precedence. This setting controls the agentswitch read root. Native configuration overrides are separate. No behavior is inferred from `GEMINI_HOME`.

The reader accepts UUID IDs and canonicalizes workspace aliases. Other ID formats are unsupported. Each display title says “metadata only”. The cache contains no native title, timestamp, producer version, transcript or complete session inventory. `updatedAt: ''` represents an unknown date and sorts after dated sessions. Search reaches cache IDs and workspaces. Native message text remains unavailable. Ambiguous ID/workspace mappings are excluded, malformed siblings get bounded diagnostic codes, and a missing workspace remains unavailable for native open. Defaults cap the single file at 1 MiB, 1,000 entries and 100 diagnostics. Symlink escapes, symlink leaves, oversized or changing files are refused. Native bytes are never rewritten. Discovery and index queries spawn no provider and make no network requests.

To open a listed agy conversation, choose agy, press C and explicitly clear the draft with Ctrl+U. Confirm the summary. The native argv is `['--conversation', exactId]` in its recorded canonical workspace. Workspace overrides, nonempty requests, redactions and fresh/outgoing operations from cache-only sources are refused. agy revalidates its account and native identity. It may show its home or a fresh context if the cached conversation is unavailable. Agentswitch sends no prompt, chooses no replacement ID and attempts no second launch. Type the next request in the native client after checking its identity.

The shared journal prevents overlap with unresolved agentswitch-owned writers, including crashed unknown writers. Other native clients cannot be universally detected. Stop concurrent writers first. Native active-session handling, project association, account policy and approvals remain with agy. Cache provenance supplies a resume candidate. Confirm the actual opened context in the native client. This launch records unknown history completeness, no history archive, no retained continuity coverage and no trusted consumption receipt. A cache-only native attempt cannot be retried as a fabricated fresh transcript.

## Incoming fresh transfers

The runtime checks exact version `1.5.14` and matching native conversation/interactive prompt help. A reviewed fresh handoff uses `['--prompt-interactive', completeJsonEnvelope]`, inherited terminal and the approved canonical cwd. Its single payload remains bounded to 16,384 UTF-8 bytes with whole-message omissions and a usable private archive. Cancelled confirmation creates no transfer archive or journal attempt. Literal arguments use `shell: false`. No permission, model, remote, project, login or automatic approval flags are added. Native settings and credentials remain native.

Like other argv transports, the payload may be visible in local process inspection. The target uses its own native account and instructions. Exit status never proves consumption or target identity. Uncertain incoming delivery survives restart and requires an explicit fresh retry. No agy receipt adapter can advance accepted coverage.

## Compatibility evidence, 2026-11-21

| Observation | Evidence and limit |
| --- | --- |
| Product | Google's [official repository](https://github.com/google-antigravity/antigravity-cli/tree/b9f5bf40b9e9e66f417f7bc6e8c0b22a079bc51a), distinct from Antigravity IDE and Gemini CLI |
| Distribution | Official [Linux x64 manifest](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json), exact immutable URL and SHA-512 retained in fixture provenance |
| Real runtime readback | Verified 1.5.14 Linux x64 archive. One regular `antigravity` executable, no links or license/notice members. Sterile no-network namespace: version/help/acp-help exit 0. No native install or personal executable used |
| Protocol | Truthful ACP v1 initialize returns `Antigravity ACP Server` / `1.5.14`, `loadSession: true`, list/load/resume capabilities. One unauthenticated `session/list {}` returns native `-32000 Authentication required`. Neither probe sends a prompt or accesses an account |
| Platforms | Publisher advertises Linux/macOS and other platforms. Only this Linux x64 executable was actually probed. Offline subprocess/PTY fixtures cover agentswitch on CI's Linux/macOS matrix. Windows and real macOS agy runtime compatibility remain unverified |
| License/API | Google [terms](https://antigravity.google/terms) apply. No open-source runtime redistribution grant was established. No executable is bundled. Official [ACP client integration](https://antigravity.google/docs/ide/extensions/acp) is documented. No direct backend/OAuth implementation or credential copying is used |

`test/fixtures/agy` retains non-account probe outputs, a relevant exact help excerpt and the hash-pinned provenance. Synthetic cache and fake-runtime tests are separate from real protocol evidence. Reproduce offline product checks with `npm run build` then `node --test test/agy-*.test.mjs`. Do not run a user-installed agy or authenticate as part of routine tests. Native help establishes advertised transport, while fake PTYs establish our argv/terminal/journal behavior. Real authenticated prompt consumption is not certified.

## Remaining public-history prerequisite

The [synthetic native replay evidence and implementation handoff](agy-replay-evidence.md) records the exact 1.5.14 Linux x64 runtime against a private loopback mock on 2026-11-22. A separate ACP process replayed public user/assistant text, separate thought chunks and usage updates. Default writable attachment changed native profile files. Reduced fixtures also establish a local summary catalog and generated JSONL transcript path, including thinking/settings exclusions, ambiguous user delimiters and an interactive session with no workspace URI in its summary.

These compatibility prerequisites support implementation work in [issue #9](https://github.com/rammicz/agentswitch/issues/9). The shipped adapter still reads only the last-ID cache. Full public-history search and outgoing transfers remain unavailable. No genuine account, external model, public tool replay, macOS runtime or unknown producer version is certified by the synthetic capture. The documented file route requires conservative workspace, activity, schema and completeness checks before implementation.
