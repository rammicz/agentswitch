# Interactive runtime component

`createRuntime` in `src/runtime.ts` prepares an opaque `LaunchPlan` and matching
picker summary, then launches that exact one-shot snapshot after confirmation.
The default CLI composes readers, index, picker, handoff archives and durable
delivery state. [Continuity](continuity.md) resolves earlier native targets and
conditionally observes matching Codex submit/completion hooks.

The runtime performs only `--version`, `--help`, and Codex `resume --help` probes.
It supports exactly **Codex 0.171.0**, **Claude Code 2.1.330**, **OpenCode opencode-ai 1.19.6** and **Antigravity CLI 1.5.14**, with required
interactive prompt/resume/workspace help shapes. Probes have a combined 64 KiB
output cap per invocation and a two second default timeout (configurable up to ten
seconds). Unknown versions, missing capabilities, nonzero results, timeout and
excess output fail preparation. Help compatibility is advertised support, not
proof of authentication, provider receipt, or model behavior. Tests launch only
local fake executables; no authenticated provider prompt smoke test has been run. The Antigravity profile retains sterile no-network real version/help/ACP handshake and missing-auth evidence; see [its limits](agy-reader.md).

The matrix follows the pinned [Codex CLI source](https://github.com/openai/codex/tree/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/cli),
[Codex resume cwd policy](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/tui/src/session_resume.rs),
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference), and the
[pinned official Claude SDK equals-form resume construction](https://github.com/anthropics/claude-agent-sdk-python/blob/3184360393a92ca8a6ec7bbbdee571afd1ce1c56/src/claude_agent_sdk/_internal/transport/subprocess_cli.py).
The SDK evidence does not establish the full interactive CLI implementation.

## Prepare and confirm

Supply explicit executable paths or let the runtime resolve the normal provider
name through absolute PATH entries. Supply a trusted `getSource` lookup returning
provider-scoped identity, recorded workspace and native compatibility. The picker
request alone cannot attest to those facts. `nativeResume: 'compatible'` must come
from an adapter that knows the source kind; incompatible or unknown native formats
require explicit fresh recovery. Codex/Claude same-agent resume accepts only an exact UUID; OpenCode accepts an exact `ses_` ID in its recorded workspace with an explicitly empty current request (see [OpenCode profile](opencode-reader.md));
there is no latest-session, name, picker, fork or cross-provider ID fallback.

`prepare(request, input, signal)` returns `PreparedContinuation<LaunchPlan>` for
the existing picker. Same-provider `auto` resumes natively. A different provider,
or explicit `mode: 'fresh'`, requires `input.handoff`:

```ts
{ prompt, includedItemIds, omittedItemIds }
```

`prompt` is the **complete serialized user prompt**, including the historical
context and separately identified current request. The runtime does not append,
select, truncate or reserialize it. Ordinary source-native resume receives only
`input.currentRequest`. A trusted `input.resumeTarget` can identify a separate
earlier target and receive the bounded missing-history `input.handoff`. The complete final initial
prompt must contain no NUL and fit **16,384 UTF-8 bytes**, including envelopes,
escaping, archive references and current request. An application can configure a
smaller limit. This conservative transport policy is neither a model token limit
nor a guarantee against OS `E2BIG`; oversized prompts require re-budgeting before
confirmation. No interactive generic file/stdin loader is claimed. Initial argv
can be visible to local process inspection, like ordinary provider prompt argv.

Source workspace choices must match the trusted recorded canonical directory;
other paths require `kind: 'override'`. Preparation and launch both check directory
access. Launch refuses a replaced directory, retargeted workspace symlink or
changed resolved executable metadata and requires a new preview/confirmation.
Executable checking covers the resolved launcher file, not all interpreter,
package dependencies or native settings; filesystem changes can still race spawn.

All provider launches use argument arrays, `shell: false`, the chosen canonical
cwd, and inherited stdin/stdout/stderr. Codex also receives explicit `-C` so a saved
resume cwd cannot override the approved workspace. Claude resume uses
`--resume=<UUID>`. OpenCode uses `[workspace, --session=ses_ID]` with no prompt or `[workspace, --prompt=completeJson]` for fresh transport. Its draft must be explicitly cleared for native resume; select F to retain it in a fresh reviewed envelope. Option termination protects literal option-looking prompts.
Antigravity uses `[--conversation, UUID]` with an explicitly empty draft and recorded workspace only, or `[--prompt-interactive, completeJson]` for fresh input. Its cache is only a native-open candidate, never a transcript or target receipt.
No approval, sandbox, trust, system-prompt, model, print-mode or authentication
flags are added. Normal environment/native configuration remain inherited; the
runtime never reads or copies credentials or native history files.

## Ownership, terminal and outcome

A process-wide terminal lease refuses overlapping interactive launches, including
distinct fresh plans, and is released on failure, cancellation or child completion.
The default process-wide native guard atomically leases provider/native IDs through the
child lifecycle. Known active and explicitly unknown owner states refuse native
resume, both during preparation and at dispatch. The injected guard contract lets
#5 supply durable ownership. The default guard cannot detect other agentswitch
processes or arbitrary external native clients, and is not evidence that a native
session is universally idle. Stop those writers first or explicitly use a fresh
handoff. No owner is killed and no lock is stolen.

Call `launch(plan)` only after the picker has restored its terminal. All three
standard descriptors must be terminals and stdin must no longer be raw. Linux and
macOS require the standard `stty` utility for termios snapshot/restoration; no
shell or extra npm runtime dependency is used. Input remains available for normal
interactive use. Completion restores termios and shows the cursor/exits the
alternate screen; temporary signal handlers are removed and ownership is released.

Parent SIGINT/SIGTERM forwarding waits 75 ms so ordinary terminal-generated Ctrl+C,
which reaches both foreground processes, can terminate the child without a second
signal. Direct parent-only signals are forwarded if the child remains running.
Node does not expose signal sender metadata: a custom native signal handler that
keeps the child running can receive a second signal after that grace period.
Universal signal-origin deduplication, descendant process supervision and native
job control are not established by this component. Foreground PTY tests cover
ordinary Ctrl+C, direct parent SIGINT/SIGTERM, resize, killed-child raw-mode
restoration and continued typed input.

A successful process creation returns `{ launched: true, code, signal,
consumption: 'unknown' }`. Numeric nonzero exits and signal exits remain distinct.
Native stdout/stderr stay visible, including authentication refusals. A generic
exit 1 is not classified as authentication failure; recovery advises checking the
native diagnostic, authenticating independently when needed and checking delivery
before a retry. No install/login command, fallback transport or automatic retry
runs. Even a completed plan cannot launch a second time. Cancellation before
spawn prevents launch; interruption after spawn leaves consumption unknown.

CLI composition is now available through [integration and recovery](integration.md). `launch` accepts synchronous `beforeSpawn` and `onSpawn(pid)` observation hooks for durable intent/launch evidence. Neither callback is a provider receipt. Observer failure after process creation stays uncertain; the runtime still restores terminal state. Cross-process journal admission remains distinct from the process-local guard.
