# Private offline search index

`SearchIndex` in `dist/search-index.js` is a programmatic component over injected `SessionAdapter`s. It searches Codex, Claude or both without a model call. The CLI and demo do not open this cache yet; real reader/picker composition and user-facing cache controls belong to integration issue #5.

```js
import { SearchIndex } from './dist/search-index.js';

const index = await SearchIndex.open({
  directory: '/existing/private-cache-parent/agentswitch-search',
  sources: [
    { sourceId: 'codex-root-configuration-v1', adapter: codexAdapter },
    { sourceId: 'claude-root-configuration-v1', adapter: claudeAdapter },
  ],
});
await index.refresh();
const hits = await index.query({
  text: 'retry failed', agent: 'all', scope: 'folder', workspace: process.cwd(),
});
await index.close();
```

The embedding application chooses a dedicated cache directory whose parent already exists. There is no implicit history-root discovery or application data directory. Configure the adapters' permitted native roots separately. One adapter per provider is supported. `sourceId` must identify that provider's exact root configuration, remain stable across restart, and change when the configured roots change. It is a namespace, not an authentication credential. Do not register a second adapter for the same provider; combine permitted roots at the adapter boundary if supported.

Only currently registered provider/source namespaces are queryable after reopen. Session storage keys include provider/source identity and native ID; returned `SessionHit`s retain their provider, native ID and original session ID. The public picker contracts are reused. Hits omit eager transcripts and carry at most three matching field/message excerpts, with message item ID and role. The adapter remains responsible for public-history projection; the index copies only the shared public fields and never serializes adapter-specific metadata.

## Matching and ordering

Queries trim surrounding whitespace, then use Unicode default lowercase and literal substring matching independently within titles, canonical workspace paths and individual public history items. There is no regex, SQL/FTS query language, accent folding or Unicode normalization. Empty/whitespace queries browse all scoped sessions with empty match lists. Adjacent messages cannot create a phrase match across their boundary. Excerpts include the first match location, bounded to 240 Unicode code points plus optional ellipses; a literal longer than that bound can be clipped. Result sets are complete, without a hidden result limit or memoized query results.

Folder scope compares exact canonical workspaces using `realpath` on ingestion and query. Descendants and sibling prefixes are excluded; symlink aliases of an existing folder compare equal. Missing/non-directory paths retain their lexical absolute spelling and remain globally discoverable; aliases of a missing path cannot be reliably canonicalized. Permission and other path errors propagate. Global scope reads only cached public text supplied by the configured adapters, and never scans unrelated machine files.

Order is timestamp instant descending, then session ID, provider ID and native ID ascending by JavaScript string code-unit order. Equivalent timestamp strings with different timezone notation tie. Invalid timestamps and duplicate native IDs within one provider discovery fail refresh before storage changes.

## Refresh, deletion and recovery

Opening restores persisted sessions without calling an adapter. `refresh()` explicitly discovers and hydrates **every** selected session through `readHistory(nativeId)`, including sessions whose metadata discovery returns empty messages. `refresh('codex')` or `refresh('claude')` replaces just that configured namespace. Public content, titles and workspaces are replaced, not appended, even when timestamps do not change. Removed sessions/items disappear, and a successful empty catalog clears that namespace. No reliable generic adapter fingerprint exists, so this is generation replacement rather than a timestamp-based incremental read optimization.

All selected provider reads are staged before one SQLite transaction. A thrown discovery/history read rejects the operation and preserves the previously committed generation for every provider. **The generic adapter contract cannot distinguish a legitimately empty catalog from an adapter returning `[]` after a degraded native read.** Native readers expose detailed diagnostics separately; #5 must gate refresh using those diagnostics/completeness signals where needed. This component cannot promise stale-data preservation for failures that an adapter reports as successful empty/partial data.

`deleteSession(agent, nativeId)` removes derived content from that provider's configured namespace. A later refresh can import the still-existing native session again. `rebuild()` rehydrates all configured adapters and atomically replaces the entire derived store, including obsolete source namespaces. It also preserves the previous generation if a source throws. Neither operation deletes native history.

Each instance serializes its writes. SQLite transactions, a five-second busy timeout, DELETE journals and rollback recovery protect concurrent processes and interrupted writes. Queries check SQLite `data_version` and reload after another connection's commit; a reader sees a complete committed generation. They also check cache identity so handles reject after another instance purges or replaces the cache. Calls already in flight or previously returned values cannot be recalled. Coordinate full purge with other active applications; close/reopen a handle after cache replacement. Cancellation signals are checked around asynchronous query preparation and before returning; synchronous scanning/SQLite work cannot be interrupted midway.

`close()` releases this handle and its in-memory copy. `purge()` closes this instance and deletes the entire dedicated owned cache, including journal artifacts. Purged instances reject further queries/refreshes. Native source files are untouched. Purge removes application files; it does not promise physical disk erasure, or clear another process's already loaded memory. Unconfigured old namespaces remain private on disk until full rebuild/purge, while always being excluded from queries.

## Storage and limits

Node >=22.15 supplies SQLite with no runtime npm dependency or FTS5 requirement. Cache directories are created as 0700, marker/database files as 0600 even under permissive umasks; existing entries must be owned and private. Symlinks, foreign files, non-regular entries and non-private targets are rejected without chmod or recursive deletion of arbitrary existing directories. SQLite uses secure deletion, DELETE journals and memory-only temporary storage. The dedicated directory contains an ownership token, `index.sqlite` and possibly its rollback journal.

Unsupported schema versions and corrupt storage fail opening; use a fresh dedicated private directory and rebuild from the adapters, or explicitly remove the identified derived directory after closing consumers. No native history needs repair. Do not move credentials, native history directories or handoff artifacts into the cache directory.

The implementation restores normalized public text in memory and performs a bounded-corpus scan on each query. Cache size, restoration time and memory grow with public history size. There is no claim that arbitrarily large histories meet the benchmark below.

## Reproducible component benchmark

```sh
npm run build
BENCHMARK_RUNNER=my-runner node benchmark/search-index.mjs /tmp/agentswitch-search-benchmark.json
```

The deterministic generator supplies 10,000 sessions (5,000/provider), exactly 100,000 short public items, four isolated canonical workspaces and fixed timestamp ties. Adapter discovery intentionally returns no messages. Cases cover complete browse-all, common/rare/absent message literals, provider filtering, title-only matches, exact-folder filtering, Unicode and punctuation. The JSON records item lengths/bytes, runtime/CPU/memory, revision, all phase durations and 100 raw samples per case, plus min/median/p95/max. Warmups and mixed measured calls all validate full results against an independent fixture oracle, including IDs, order and excerpt provenance. Timings include the complete query service call and all output construction; validation follows the timed span. No warm query calls an adapter. The acceptance budget uses **maximum <=200 ms for every case**, not a cross-case average.

Cold open/discovery/hydration/commit, reopen/first query, unchanged refresh, 100 changed/10 removed/10 added refresh and full rebuild are measured separately. These are **fake-adapter component** ingestion timings. They do not measure native reader cold ingestion: the current native readers can rescan catalogs per `readHistory` call, so extrapolation to real 10,000-session ingestion would be invalid. Default correctness tests are offline; the larger benchmark is opt-in. Retain generated JSON with the runner evidence when reporting a measured result.

Native CLI refresh uses `refresh(agent, {preserveMissing: true})` for a degraded generation. This updates healthy staged sessions without deleting earlier entries absent from an unreliable scan. Healthy generations retain ordinary replacement semantics. The CLI displays per-source warnings and independently revalidates selected native history before preparation/launch. This explicit policy belongs to composition; generic adapters still must signal failures.
