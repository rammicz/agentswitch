# agentswitch

**Pick up the conversation. Change the agent.**

Find a coding conversation, choose the agent you want to continue with, and get back to work. The first target is **Codex ↔ Claude Code**: when one quota runs out, your task should not have to start over.

> **Status: early development scaffold.** The CLI, shared types, in-memory search, injected-service picker, and an interactive demo exist. Reading real sessions, persistent search, native resume, and cross-agent handoffs are tracked in [GitHub Issues](https://github.com/rammicz/agentswitch/issues). No working provider integration is claimed yet. The package has not been published to npm.

## The intended experience

Install once, open a project folder, and run:

```sh
cd your-project
agentswitch
```

A quiet picker opens with sessions from that folder. Type to search titles and conversation history, use left/right to filter the source agent, or switch to global scope to find conversations from other folders. Select a session, choose a target agent, and continue.

```text
agentswitch

Search: fix the retry logic
← → Agent: all                 Tab Scope: folder

› codex   Fix retry logic in the upload worker
  claude  Investigate intermittent upload failures

↑ ↓ Select · Enter choose target · Esc quit
```

The picker is inspired by native resume commands, with one shared view across agents. Source filtering and target selection are separate: finding a Codex session should still let you continue it in Claude Code.

## Try the scaffold today

Requires Node.js 22+ and npm. Linux and macOS are the initial platform targets; Windows support needs validation. The demo does not require either agent.

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

`npm link` installs the local development command. You can also run `node dist/cli.js --demo` without linking. Use `npm uninstall -g agentswitch` to remove the link. Running `agentswitch` without options currently prints the scaffold status and help.

The demo uses three synthetic sessions, including one in a different workspace. It reads no agent history, writes no history store, makes no network or model calls, and launches no agent.

| Key | In the session list | In progressive views |
| --- | --- | --- |
| Type / Backspace | Search titles, workspaces, and message text | Edit a workspace override |
| ↑ / ↓ | Move selection | Scroll transcript or summary |
| ← / → | Cycle All / Codex / Claude | Cycle target agent in target selection |
| Tab | Toggle folder / global scope | — |
| Enter | Preview matches and transcript | Choose target, prepare summary, then confirm |
| W | Search text | Explicit workspace override in target selection |
| Esc | Exit | Return to previous view |
| Ctrl+C | Exit | Exit |

The demo uses the same injected-service picker as future integrations. Its final summary is synthetic; confirming exits with a demo notice and **does not transfer a conversation**. A global selection starts with its recorded folder. Missing folders require an explicit valid override before preparing the summary.

## What “transfer” means

Agents have different private session formats, tool protocols, and permission models. A handoff cannot promise identical runtime state.

The planned first release will:

1. Read public conversation content from the source agent without rewriting its native session files.
2. Normalize messages, paths, plans, and relevant tool outcomes with source attribution.
3. Prepare a bounded history payload, showing what was included and omitted before launch.
4. Start a fresh session in the selected target with that history as historical context and a separate current request.
5. Keep a local transfer record and references to omitted history so the conversation remains traceable.

Same-agent continuation will use native resume when supported. Cross-agent continuation initially uses attributed context in a fresh session. Native history import is a later, capability-tested optimization.

Hidden reasoning, live processes, in-flight tool calls, authentication, permissions, and model internals do not transfer. Context limits may require omitting whole messages. Conversation text is historical data; it must not become system instructions or replay old commands. Code changes remain on disk: switching agents does not move a checkout, copy files, or recreate another workspace.

For a global result, the planned default is its recorded source workspace. The picker must show that path and require an explicit choice before using a different folder. Missing folders and active sessions need clear recovery paths.

## Privacy and agent access

The design is local first. Session reading and indexing should require no model call and no new account. When you confirm a handoff, the selected history is sent through the target agent under that agent's account and data policies. Review sensitive content before transferring it.

Codex and Claude Code will need to be installed and authenticated independently for real continuation. agentswitch will not pool quotas, copy credentials, or bypass provider limits. Each target keeps its normal workspace instructions and approval behavior.

Persistent index storage, deletion controls, redaction, and configurable history roots are planned work. The scaffold has no telemetry and creates no application data directory.

## Roadmap

| Stage | Scope | Status |
| --- | --- | --- |
| Foundation | Installable development CLI, shared types, keyboard demo, CI, documentation | Scaffold available |
| [First usable release](https://github.com/rammicz/agentswitch/issues/5) | Codex and Claude Code discovery, folder/global search, transcript preview, native resume, bounded cross-agent handoff, launch and recovery | Planned; component tasks linked from integration issue |
| [Continuity](https://github.com/rammicz/agentswitch/issues/6) | Durable transfer lineage, A → B → A missing-history delivery, archive retrieval, capability-tested native import | Deferred |
| More agents | [OpenCode](https://github.com/rammicz/agentswitch/issues/11), [agy](https://github.com/rammicz/agentswitch/issues/9), [grokbuild](https://github.com/rammicz/agentswitch/issues/12) | Deferred; validate each integration before promising compatibility |
| [Community requests](https://github.com/rammicz/agentswitch/issues/13) | Other popular coding agents, based on demand | Open to proposals; structured intake deferred |

An adapter is supported only after its discovery, history parsing, launch behavior, and compatibility fixtures pass. Listing an agent on the roadmap does not imply support today.

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
src/cli.ts           CLI entry point and honest scaffold status
src/domain.ts        Sessions, history items, queries, handoff state
src/adapters/        Read-only adapter contract and planned agent catalog
src/search.ts        In-memory search baseline
src/tui/             Synthetic data and keyboard interaction prototype
test/                Search, CLI, offline PTY and terminal lifecycle checks
docs/                Architecture, research references, contribution guidance
```

See [architecture](docs/architecture.md), [research notes](docs/research.md), and [contributing](CONTRIBUTING.md). Work is tracked as individual [issues](https://github.com/rammicz/agentswitch/issues) with acceptance and verification criteria. New adapter proposals should include sanitized fixtures and documented CLI capabilities, never personal transcripts or credentials.

## Inspiration and license

The handoff architecture draws on a supplied source investigation of [T3 Code](https://github.com/pingdotgg/t3code), particularly canonical history, deterministic message selection, and durable delivery state. [Research notes](docs/research.md) pin the inspected revision and distinguish source evidence from future agentswitch behavior. No upstream implementation code is bundled.

[MIT](LICENSE).
