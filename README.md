# agentswitch

**Pick up the conversation. Change the agent.**

Find a coding conversation, choose the agent you want to continue with, and get back to work. The first target is **Codex ↔ Claude Code**: when one quota runs out, your task should not have to start over.

> **Status: early integration.** The default terminal CLI now reads supported local Codex/Claude/OpenCode/Antigravity/Grok Build sessions, searches public text and offers confirmed native resume or a fresh cross-agent handoff. Antigravity CLI 1.5.14 adds a bounded public-text source profile for quiescent local stores, alongside incoming targets and sparse metadata native open. Private archives and a durable delivery journal support explicit recovery. Offline PTY tests use fake providers. Real provider consumption is not certified. See [native integration and recovery](docs/integration.md). The package has not been published to npm.

## The intended experience

Install once, open a project folder, and run:

```sh
cd your-project
agentswitch
```

A quiet picker opens with sessions from that folder and shows how recently each was used. Move the highlight to see the session’s folder, timestamp and available conversation excerpts in the details pane. Narrow terminals show details below the list. Press ↑ from the first result to focus Search, and ↓ to return to the results. Type to search titles and conversation history, use left/right to filter the source agent, or switch to global scope. Select a session, choose a target agent, and continue.

```text
agentswitch

Shift+←/→ Agent: all            Tab Scope: folder

  Search: fix the retry logic
› codex   Fix retry logic in the upload worker
  claude  Investigate intermittent upload failures

↑ ↓ Select · Enter choose target · Esc quit
```

The picker is inspired by native resume commands, with one shared view across agents. Source filtering and target selection are separate: finding a Codex session should still let you continue it in Claude Code.

## Try it locally

Download the package and checksum from [GitHub Releases](https://github.com/rammicz/agentswitch/releases), then follow the [tarball installation steps](docs/releasing.md#install-a-verified-tarball).

A global npm installation from a release tarball checks GitHub Releases once per UTC day when you open the picker. The picker displays a notice when a newer release is available. Run `agentswitch update` to check immediately and install into the same npm prefix. Set `AGENTSWITCH_NO_UPDATE_CHECK=1` to disable startup checks. [Installation and updates](docs/releasing.md)

Requires Node.js **22.15 or later** and npm. This release targets Linux, macOS, and native Windows 10/11. On Windows use a terminal with an attached console, such as Windows Terminal with PowerShell or Command Prompt. The demo runs without any agent installed.

To build from source:

```sh
git clone https://github.com/rammicz/agentswitch.git
cd agentswitch
npm ci
npm run build
npm link

agentswitch --help
agentswitch --demo
agentswitch --demo --global
```

`npm link` installs the local development command. You can also run `node dist/cli.js --demo` without linking. Use `npm uninstall -g agentswitch` to remove the link. Running `agentswitch` without options opens the native picker in an interactive terminal. Set `CODEX_HOME`, `CODEX_SQLITE_HOME`, `CLAUDE_CONFIG_DIR`, `OPENCODE_DB`, `XDG_DATA_HOME`, `AGENTSWITCH_AGY_ROOT`, `GROK_HOME` or `AGENTSWITCH_STATE_DIR` to choose isolated roots; see [integration and recovery](docs/integration.md).

The demo uses three synthetic sessions, including one in a different workspace. It reads no agent history, writes no history store, makes no network or model calls, and launches no agent.

The CI release gate tests the actual package on Linux, macOS, and Windows with Node 22.15.0 and the current Node 22 release. Find the tarball and platform-specific commands in the [installation guide](docs/releasing.md). The package remains unpublished on npm.

| Key | In the session list | In progressive views |
| --- | --- | --- |
| Type / Backspace | Search titles, workspaces, and message text | Edit a workspace override |
| ↑ / ↓ | Move between search and results | Scroll transcript, target options or summary |
| ← / → | Open the highlighted session’s subagents with →, return with ← | Cycle target agent in target selection |
| Shift+← / Shift+→ | Cycle source agents | — |
| Tab | Toggle folder / global scope | — |
| Enter | Preview matches and transcript | Choose target, prepare summary, then confirm |
| F2 | Show source warnings | — |
| F3 | Show or hide subagents in results | — |
| W | Search text | Explicit workspace override in target selection |
| Esc | Exit | Return to previous view |
| Ctrl+C | Exit | Exit |

The demo uses the same injected-service picker as the native integration. Its final summary is synthetic; confirming exits with a demo notice and **does not transfer a conversation**. A global selection starts with its recorded folder. Missing folders require an explicit valid override before preparing the summary.

## What “transfer” means

Agents have different private session formats, tool protocols, and permission models. A handoff cannot promise identical runtime state.

The fresh-context handoff flow will:

1. Read public conversation content from the source agent without rewriting its native session files.
2. Normalize messages, paths, plans, and relevant tool outcomes with source attribution.
3. Prepare a bounded history payload, showing what was included and omitted before launch.
4. Start a fresh session in the selected target with that history as historical context and a separate current request.
5. Keep a local transfer record and references to omitted history so the conversation remains traceable.

Same-agent continuation will use native resume when supported. Cross-agent continuation initially uses attributed context in a fresh session. Native history import is a later, capability-tested optimization.

Hidden reasoning, live processes, in-flight tool calls, authentication, permissions, and model internals do not transfer. Context limits may require omitting whole messages. Conversation text is historical data; it must not become system instructions or replay old commands. Code changes remain on disk: switching agents does not move a checkout, copy files, or recreate another workspace.

For a global result, the default is its recorded source workspace. The picker must show that path and require an explicit choice before using a different folder. Missing folders and active sessions need clear recovery paths.

## Privacy and agent access

The design is local first. Session reading and indexing should require no model call and no new account. When you confirm a handoff, the selected history is sent through the target agent under that agent's account and data policies. Review sensitive content before transferring it.

Each selected target will need to be installed and authenticated independently for real continuation. agentswitch will not pool quotas, copy credentials, or bypass provider limits. Each target keeps its normal workspace instructions and approval behavior.

The programmatic readers accept explicit native roots. See [Codex reader](docs/codex-reader.md), [Claude Code reader](docs/claude-reader.md), [OpenCode 1.19.6 profile](docs/opencode-reader.md), [Antigravity local storage profile](docs/agy-reader.md), and [Grok Build pinned profile](docs/grok-reader.md). The [programmatic search index](docs/search-index.md) supports private persistence, refresh, derived-session deletion, full rebuild and purge over explicitly configured adapters. The [handoff component](docs/handoff.md) supports explicit public-text redaction before preparation and private archive retention. The CLI shows sessions as each provider returns, then reads public messages in the selected scope as you search. It previews the exact handoff and requires confirmation. The CLI has no telemetry. Approved transfers use separate archives and a durable journal.

## Roadmap

| Stage | Scope | Status |
| --- | --- | --- |
| Foundation | Installable development CLI, shared types, keyboard demo, CI, documentation | Scaffold available |
| [First usable release](https://github.com/rammicz/agentswitch/issues/5) | Codex and Claude Code discovery, folder/global search, transcript preview, native resume, bounded cross-agent handoff, launch and recovery | [Shipped with offline fixture and PTY verification. Authenticated consumption unverified](docs/integration.md) |
| [Continuity](https://github.com/rammicz/agentswitch/issues/6) | Durable lineage, exact missing-history sets and conditional Codex return via native hooks; reviewed fresh fallbacks | [Offline integration](docs/continuity.md) |
| [OpenCode](https://github.com/rammicz/agentswitch/issues/11) | 1.x public history (tested on 1.19.6; other 1.x producers warn as untested), empty-request native resume of 1.19.6 sessions and fresh transfers | [Offline fixture/PTY tested; native consumption unverified](docs/opencode-reader.md) |
| [Antigravity CLI](https://github.com/rammicz/agentswitch/issues/9) | Observed 1.5.14 quiescent public-text storage, incoming/outgoing fresh transfers and confirmed empty-request native open | [Offline fixture/PTY tested. Real-account consumption unverified](docs/agy-reader.md) |
| [Grok Build](https://github.com/rammicz/agentswitch/issues/12) | Public v1 source history and Grok Build target (tested 1.0.45); confirmed empty-request native open and four-direction handoffs | [Offline fixture/PTY tested; actual provider consumption unverified](docs/grok-reader.md) |
| [Community requests](https://github.com/rammicz/agentswitch/issues/13) | Other popular coding agents, based on demand | [Propose an adapter](https://github.com/rammicz/agentswitch/issues/new?template=adapter-proposal.md). Compatibility investigation before implementation |

An adapter is supported for its documented capabilities only after the applicable discovery, public history, launch and compatibility fixtures pass. A source-and-target profile needs all four. The [support policy](docs/adapter-support.md) defines demand and maintenance triage, the evidence checklist and version-specific limits. Partial profiles keep their unavailable capabilities visible. Listing an agent on the roadmap does not imply support today.

## Development

```sh
npm ci
npm run check
npm test
npm run dev -- --demo
npm pack --dry-run
```

The offline PTY tests require Python 3 with its standard library on Linux or macOS. They use temporary folders and fake services without accessing provider histories.

There are no runtime npm dependencies. TypeScript and Node type definitions are development dependencies.

```text
src/cli.ts           CLI entry point, native picker and explicit recovery commands
src/domain.ts        Sessions, history items, queries, handoff state
src/adapters/        Read-only Codex/Claude/OpenCode/Grok readers, agy metadata and contracts
src/search.ts        In-memory demo search baseline
src/search-index.ts  Private persistent offline query component
src/runtime.ts       Planner and inherited-terminal launch component
src/handoff.ts       Deterministic byte-bounded public-history preparation
src/archive.ts       Private immutable archives and bounded retrieval
src/tui/             Synthetic data and keyboard interaction prototype
test/                Search, CLI, offline PTY and terminal lifecycle checks
docs/                Architecture, research references, contribution guidance
```

See [architecture](docs/architecture.md), [research notes](docs/research.md), and [contributing](CONTRIBUTING.md). Work is tracked as individual [issues](https://github.com/rammicz/agentswitch/issues) with acceptance and verification criteria. Use the [adapter proposal template](https://github.com/rammicz/agentswitch/issues/new?template=adapter-proposal.md) with exact distribution/version, demand, official capability evidence and sanitized public fixtures or explicit gaps. Proposals start in `queue:dev` with `status:triage`. Omit personal transcripts and credentials.

## Inspiration and license

The handoff architecture draws on a supplied source investigation of [T3 Code](https://github.com/pingdotgg/t3code), particularly canonical history, deterministic message selection, and durable delivery state. [Research notes](docs/research.md) pin the inspected revision and distinguish source evidence from future agentswitch behavior. No upstream implementation code is bundled.

[MIT](LICENSE).

The native picker also offers **C** to edit the current request, **X** to add a literal redaction, and **F** to choose a fresh context. Review the exact final prompt before confirming. Use `agentswitch transfers list|show|retry|abort|delete` for deliberate recovery, and `agentswitch cache purge` to remove derived search data separately. A provider exit leaves delivery uncertain without a trusted consumption receipt.
