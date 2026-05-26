# Prism — Anonymous Code Release

Persistent file-level memory for coding agents.

This repository is a modified snapshot of the OpenCode agent framework that
implements the file-memory mechanism described in the accompanying paper.

The original OpenCode README is preserved at `UPSTREAM_README.md` and its
license at `UPSTREAM_LICENSE`.

## What this adds to OpenCode

Three pieces composed on top of the OpenCode source tree:

1. **Persistent file-memory.** A per-file `(path, content-hash) → (summary,
   facets[])` cache, persisted on disk under
   `<workdir>/.opencode/file-history/` (one JSONL file per source path,
   with one entry per content hash). Edits invalidate entries automatically
   through the content hash; no TTL or manual eviction is required.
2. **Facet accumulation.** After each reasoning chunk the agent emits
   between tool calls, the system distills at most one new
   identifier-grounded fact per recently-read file and appends it to the
   memory entry, with a small bounded cap per file (see `history.ts`).
3. **`read_summary` tool.** The agent gains one new tool that returns the
   cached summary-plus-facet briefing for a path, letting it skip a full
   re-read when accumulated knowledge already suffices.

## Source changes

All modifications live inside `packages/opencode/`. Eleven files are
added or modified relative to the upstream OpenCode `dev` branch.

| File | Status | Role |
|---|---|---|
| `packages/opencode/src/file/history.ts` | **new** | Core file-memory: on-disk `(path, hash) → (summary, facets[])` cache, the LLM-backed summarizer / distiller / aggregator, and the in-memory state object that gates everything on `OPENCODE_FILE_HISTORY=1`. |
| `packages/opencode/src/tool/read_summary.ts` | **new** | The `read_summary(path)` tool: returns the cached briefing for `path`. |
| `packages/opencode/src/tool/read_summary.txt` | **new** | Tool description shown to the agent. The only new agent-visible text. |
| `packages/opencode/src/tool/read.ts` | modified | Hooks `recordRead(path, hash, content)` after every successful read, scheduling background summarization and enqueueing the file for facet distillation. |
| `packages/opencode/src/tool/read.txt` | modified | One-line note pointing the agent at the cached briefing. |
| `packages/opencode/src/tool/edit.ts` | modified | (a) `recordObservation` hook that distills a facet from the reasoning surrounding each edit; (b) an indent-correction fix for the fallback string replacer, with regression coverage in `test/tool/edit.test.ts`. |
| `packages/opencode/src/tool/registry.ts` | modified | Conditionally register `read_summary` only when `OPENCODE_FILE_HISTORY=1`. |
| `packages/opencode/src/tool/task.ts` | modified | Propagate file-memory context across sub-agent task boundaries. |
| `packages/opencode/src/session/processor.ts` | modified | Wire `recordRead` / `recordObservation` into the session lifecycle. |
| `packages/opencode/src/effect/app-runtime.ts` | modified | Register the file-memory Effect layer in the application runtime. |
| `packages/opencode/test/tool/edit.test.ts` | **new** | Regression tests for the indent fix in `edit.ts`. |

## Building

OpenCode is a TypeScript monorepo built with Bun ≥ 1.3.11. From the repo
root:

```bash
bun install
cd packages/opencode
bun run build -- --skip-embed-web-ui
```

The `--skip-embed-web-ui` flag skips the optional web frontend build — only
the CLI binary is needed for evaluation. The compiled CLI binary lands at
`packages/opencode/dist/opencode-linux-x64/bin/opencode`.

## Activation

The new behavior is gated behind two environment variables, both off by
default:

| Variable | Effect |
|---|---|
| `OPENCODE_FILE_HISTORY=1` | Enables the file-memory cache and registers the `read_summary` tool. When unset, the binary behaves exactly like upstream OpenCode. |
| `OPENCODE_FH_FACETS=1` | Enables facet distillation. With `OPENCODE_FILE_HISTORY=1` set and this one unset, the system stores only the base summary. |

The auxiliary memory LLM (used internally for summarization, facet
distillation, and aggregation) is configured by:

| Variable | Effect |
|---|---|
| `OPENCODE_FH_BASE_URL` | OpenAI-compatible base URL for the memory LLM. |
| `OPENCODE_FH_MODEL` | Model id for the memory LLM. |
| `OPENCODE_FH_API_KEY` | API key (use `dummy` if the proxy does not check). |

Two optional flags toggle alternative modes for comparison studies:

| Variable | Effect |
|---|---|
| `OPENCODE_FH_SUMMARY_LONG=1` | Replace the facet pipeline with one larger unstructured summary per file. |
| `OPENCODE_REPO_MAP=1` | Inject an Aider-style static repository map into the system prompt. |
| `OPENCODE_REPO_MAP_MAX_TOKENS` | Token budget for the repo-map injection (default 4096). |

## Verifying activation

With `OPENCODE_FILE_HISTORY=1` set, the `read_summary` tool will be
registered alongside the standard tools. After the agent reads any file,
a JSONL entry is appended under `<workdir>/.opencode/file-history/`,
one file per source path with one record per content hash, each containing
`{ hash, summary, facets[] }`.

## Tests

The indent-fix regression suite for the `edit` tool:

```bash
cd packages/opencode
bun test test/tool/edit.test.ts
```

## License

OpenCode is distributed under the MIT License (see `UPSTREAM_LICENSE`).
The modifications above are released under the MIT License (see `LICENSE`).
