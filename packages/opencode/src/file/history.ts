/**
 * File History module — per-file knowledge caching for multi-agent context sharing.
 *
 * Core mechanics:
 * 1. After a read_file, a small LLM generates a summary of what the agent learned
 * 2. Summaries are stored as JSONL keyed by file path + content hash
 * 3. On subsequent reads, a sufficiency check decides: return summary or full content
 * 4. When spawning subagents (TaskTool), parent's file summaries are injected into child prompt
 *
 * Activation: Set environment variable OPENCODE_FILE_HISTORY=1 to enable.
 * Uses the configured small_model from opencode.jsonc for summary generation.
 */

import { Effect, Layer, Context } from "effect"
import * as fs from "fs/promises"
import * as path from "path"
import * as crypto from "crypto"
import { generateText } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"

export namespace FileHistory {
  const log = Log.create({ service: "file.history" })

  export interface Entry {
    filepath: string
    contentHash: string
    agent: string
    sessionID: string
    operation: "read" | "write"
    summary: string
    timestamp: number
    /** "summary" = full LLM-generated summary; "facet" = single observation extracted from agent reasoning */
    kind?: "summary" | "facet"
  }

  interface State {
    cache: Map<string, Entry>
    /** facets indexed by `${filepath}::${contentHash}` */
    facetCache: Map<string, Entry[]>
    /** aggregated summary cache (avoids re-aggregating on every read_summary) */
    aggCache: Map<string, { summary: string; facetCount: number }>
    /** per-session list of file paths read recently (since last observation flush). Ordered by recordRead time. */
    recentReadsBySession: Map<string, string[]>
    pending: Set<string>
    initialized: boolean
    llmProvider: ReturnType<typeof createOpenAICompatible> | null
    llmModelId: string
    facetsEnabled: boolean
    summaryLong: boolean
  }

  export interface Interface {
    readonly isEnabled: () => boolean
    readonly getEntry: (filepath: string) => Effect.Effect<Entry | undefined>
    readonly checkSufficiency: (filepath: string, agentIntent: string) => Effect.Effect<boolean>
    readonly recordRead: (filepath: string, agent: string, sessionID: string) => Effect.Effect<void>
    /** Pair the agent's reasoning text with reads recorded since the last observation in this session. */
    readonly recordObservation: (agentText: string, agent: string, sessionID: string) => Effect.Effect<void>
    readonly getOrGenerateSummary: (filepath: string, agent: string, sessionID: string) => Effect.Effect<{ summary: string; source: "cache" | "generated" | "aggregated" }>
    readonly getHandoff: (sessionID: string) => Effect.Effect<string>
    readonly getAllEntries: (sessionID: string) => Effect.Effect<Entry[]>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/FileHistory") {}

  // ---- Storage helpers ----

  function storageDir(): string {
    return path.join(Instance.directory, ".opencode", "file-history")
  }

  function entryPath(filepath: string): string {
    const relative = path.relative(Instance.directory, filepath)
    const safe = relative.replace(/[/\\]/g, "__")
    return path.join(storageDir(), safe + ".jsonl")
  }

  async function ensureStorageDir(): Promise<void> {
    await fs.mkdir(storageDir(), { recursive: true })
  }

  async function loadEntries(filepath: string): Promise<Entry[]> {
    const p = entryPath(filepath)
    try {
      const content = await fs.readFile(p, "utf-8")
      return content.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }

  async function appendEntry(entry: Entry): Promise<void> {
    await ensureStorageDir()
    await fs.appendFile(entryPath(entry.filepath), JSON.stringify(entry) + "\n")
  }

  async function getFileHash(filepath: string): Promise<string | undefined> {
    try {
      const content = await fs.readFile(filepath)
      return crypto.createHash("md5").update(content).digest("hex")
    } catch {
      return undefined
    }
  }

  // ---- LLM helpers ----

  async function callLLM(state: State, prompt: string): Promise<string> {
    if (!state.llmProvider) throw new Error("FileHistory LLM not initialized")
    const model = state.llmProvider.chatModel(state.llmModelId)
    const result = await generateText({
      model,
      messages: [{ role: "user", content: prompt }],
      maxTokens: state.summaryLong ? 1500 : 500,
    })
    return result.text
  }

  function initLLM(state: State): void {
    if (state.initialized) return
    state.initialized = true

    const enabled = process.env.OPENCODE_FILE_HISTORY === "1"
    if (!enabled) {
      log.info("file-history disabled (set OPENCODE_FILE_HISTORY=1 to enable)")
      return
    }

    // Read config from .opencode/opencode.jsonc to find the model
    // We look for the small_model or fall back to environment variables
    const apiKey = process.env.OPENCODE_FH_API_KEY ?? "dummy"
    const baseURL = process.env.OPENCODE_FH_BASE_URL ?? ""
    const modelId = process.env.OPENCODE_FH_MODEL ?? ""

    if (!baseURL || !modelId) {
      log.info("file-history: missing env vars (OPENCODE_FH_BASE_URL, OPENCODE_FH_MODEL)")
      return
    }

    state.llmProvider = createOpenAICompatible({
      name: "file-history",
      apiKey,
      baseURL,
    })
    state.llmModelId = modelId
    state.facetsEnabled = process.env.OPENCODE_FH_FACETS === "1"
    state.summaryLong = process.env.OPENCODE_FH_SUMMARY_LONG === "1"
    log.info("file-history enabled", { model: modelId, baseURL, facets: state.facetsEnabled, summaryLong: state.summaryLong })
    console.error(`[FH] File History ENABLED (model=${modelId}, baseURL=${baseURL}, facets=${state.facetsEnabled}, summaryLong=${state.summaryLong})`)
  }

  // ---- Prompt builders ----

  function buildSummaryPrompt(filepath: string, content: string, summaryLong: boolean): string {
    const cap = summaryLong ? 20000 : 8000
    const truncated = content.length > cap ? content.slice(0, cap) + "\n...(truncated)" : content
    const instruction = summaryLong
      ? "Provide a detailed summary (1-2 paragraphs) covering: the file's purpose, key symbols (functions, classes, exports) with brief descriptions, notable defaults or edge cases, and anything an editor of this file should know."
      : "Provide a concise summary (2-4 sentences) of what this file does, its key components (functions, classes, exports), and its role in the project. Focus on information that would help another agent understand whether they need to read the full file."
    return `You are analyzing a source code file for an AI coding agent.

File: ${filepath}

Content:
${truncated}

${instruction}

Summary:`
  }

  function buildFacetPrompt(filepath: string, agentText: string, existingSummary?: string, existingFacets?: string[]): string {
    const text = agentText.length > 2500 ? agentText.slice(0, 2500) + "...(truncated)" : agentText
    const priorSummaryBlock = existingSummary
      ? `\nEXISTING BASE SUMMARY (do not restate this):\n${existingSummary}\n`
      : ""
    const priorFacetsBlock = existingFacets && existingFacets.length
      ? `\nEXISTING FACETS for this file (do not paraphrase any of these):\n${existingFacets
          .slice(-8)
          .map((f, i) => `${i + 1}. ${f}`)
          .join("\n")}\n`
      : ""
    return `An AI coding agent just read a file, then made the following observation/reasoning.

FILE PATH: ${filepath}
${priorSummaryBlock}${priorFacetsBlock}
AGENT'S REASONING (after reading):
${text}

TASK: Extract ONE specific, durable, file-level fact that the agent encountered in this read — a fact about a method, class, branch, invariant, edge case, default, constant, or API contract. Prefer concrete identifier-level details over generic descriptions. Rephrase any task-specific framing into a timeless statement about the file (e.g., "X does Y" rather than "X is where we fix Z"). The fact should be useful to a future agent who will face a different, unrelated task.

REQUIREMENTS:
- Mention at least one concrete identifier — a method name, class name, attribute, constant, or backticked symbol from the reasoning when possible.
- Phrase the fact as a timeless statement about the file's behavior, structure, or contract.
- If the agent's reasoning mentions specific symbols, defaults, edge cases, or behaviors, you SHOULD emit a facet — even if it overlaps slightly with the base summary, as long as it adds a more specific detail.
- Only respond with exactly NO_NEW_FACET if the reasoning is purely about the agent's intent/plan with NO concrete file-level details, OR if the only possible output exactly paraphrases the base summary / an existing facet with no new specifics.

Otherwise, respond with just the 1-sentence facet, nothing else.

GOOD examples (concrete, identifier-level, non-redundant):
- "\`Query.clone()\` preserves the \`combined_queries\` tuple when duplicating combinator querysets such as union/intersection."
- "\`Query._add_q()\` recursively processes \`Q\` objects and threads options like \`simple_col\` through to child filter construction."
- "\`get_order_dir()\` parses a leading '-' on ordering strings and normalizes the direction using the \`ORDER_DIR\` mapping."
- "\`URLValidator\` rejects unencoded ':', '@', or '/' inside the user:pass credentials segment per RFC 1738."

REPHRASE examples (task-specific → timeless):
- BAD: "The pagination test suite where a regression test should be added."
- GOOD: "\`tests/pagination/test_paginator.py\` exercises \`Paginator.page()\` boundary cases against \`object_list\` of varying lengths."

EMIT NO_NEW_FACET ONLY WHEN:
- The reasoning is pure intent ("I'll edit this file", "let me look at this next") with no file-level facts.
- The only possible facet is a near-exact paraphrase of the base summary or an existing facet.

FACET:`
  }

  function buildAggregatorPrompt(filepath: string, facets: string[]): string {
    const list = facets.map((f, i) => `${i + 1}. ${f}`).join("\n")
    return `Multiple AI coding agents have observed the file at ${filepath}. Their individual observations (facets) are:

${list}

TASK: Synthesize these into a coherent 2-4 sentence summary of what this file is and what's notable about it. Preserve specific symbol names (functions, classes, line numbers) and concrete details. Remove redundancy. If facets contradict, note both views briefly.

SUMMARY:`
  }

  /** Heuristic: only extract a facet if the agent text appears to contain real reasoning. */
  function isRichSignal(text: string): boolean {
    if (text.length < 80) return false
    // Look for code symbols, line numbers, file path mentions, or backtick identifiers
    const hasBackticks = /`[^`]+`/.test(text)
    const hasLineRef = /\bline\s+\d+\b/i.test(text) || /:\d+\b/.test(text)
    const hasIdentifier = /\b[A-Z][a-zA-Z]+|\b[a-z]+_[a-z_]+/.test(text)
    return hasBackticks || hasLineRef || hasIdentifier
  }

  function buildSufficiencyPrompt(filepath: string, summary: string, agentIntent: string): string {
    const intentTruncated = agentIntent.length > 200 ? agentIntent.slice(0, 200) + "..." : agentIntent
    return `Given this file summary and the agent's current task, decide if the summary provides enough context.

File: ${filepath}

Summary:
${summary}

Agent's task:
${intentTruncated || "(general exploration)"}

Answer YES unless the agent clearly needs to see exact code (e.g., specific line numbers, exact syntax, debugging a particular function, or modifying the file).
Answer YES or NO only.`
  }

  function buildHandoffText(entries: Entry[]): string {
    if (entries.length === 0) return ""

    // Limit to 10 most recent entries to avoid context bloat
    const recent = entries.slice(-10)
    const lines = recent.map((e) => {
      const rel = path.relative(Instance.directory, e.filepath)
      const shortSummary = e.summary.length > 150 ? e.summary.slice(0, 150) + "..." : e.summary
      return `- ${e.operation} \`${rel}\`: ${shortSummary}`
    })

    return [
      `# File context from parent agent`,
      ``,
      ...lines,
    ].join("\n")
  }

  // ---- Main implementation ----

  function getEntryEffect(state: State, filepath: string) {
    return Effect.gen(function* () {
      const cached = state.cache.get(filepath)
      if (cached) {
        const currentHash = yield* Effect.promise(() => getFileHash(filepath))
        if (currentHash && currentHash === cached.contentHash) return cached
        state.cache.delete(filepath)
        // Also evict any facets keyed under stale hash
        state.facetCache.delete(`${filepath}::${cached.contentHash}`)
        state.aggCache.delete(`${filepath}::${cached.contentHash}`)
        return undefined
      }

      const entries = yield* Effect.promise(() => loadEntries(filepath))
      if (entries.length === 0) return undefined

      const currentHash = yield* Effect.promise(() => getFileHash(filepath))
      if (!currentHash) return undefined

      // Find the latest "summary" entry matching current hash
      const summaries = entries.filter((e) => (e.kind ?? "summary") === "summary" && e.contentHash === currentHash)
      if (summaries.length === 0) return undefined
      const latest = summaries[summaries.length - 1]
      state.cache.set(filepath, latest)

      // Hydrate facetCache with all facets matching current hash
      const facets = entries.filter((e) => e.kind === "facet" && e.contentHash === currentHash)
      if (facets.length > 0) {
        state.facetCache.set(`${filepath}::${currentHash}`, facets)
      }
      return latest
    })
  }

  export const layer = Layer.effect(
    Service,
    Effect.sync(() => {
      const state: State = {
        cache: new Map(),
        facetCache: new Map(),
        aggCache: new Map(),
        recentReadsBySession: new Map(),
        pending: new Set(),
        initialized: false,
        llmProvider: null,
        llmModelId: "",
        facetsEnabled: false,
        summaryLong: false,
      }

      const sessionEntries = new Map<string, Entry[]>()

      function addSessionEntry(sessionID: string, entry: Entry) {
        const list = sessionEntries.get(sessionID) ?? []
        const idx = list.findIndex((e) => e.filepath === entry.filepath)
        if (idx >= 0) list[idx] = entry
        else list.push(entry)
        sessionEntries.set(sessionID, list)
      }

      return Service.of({
        isEnabled: () => {
          initLLM(state)
          return state.llmProvider !== null
        },

        getEntry: (filepath) => getEntryEffect(state, filepath),

        checkSufficiency: (filepath, agentIntent) =>
          Effect.gen(function* () {
            if (!state.llmProvider) return false

            const entry = yield* getEntryEffect(state, filepath)
            if (!entry) return false

            try {
              const prompt = buildSufficiencyPrompt(filepath, entry.summary, agentIntent)
              const response = yield* Effect.promise(() => callLLM(state, prompt))
              const answer = response.trim().toUpperCase()

              const rel = path.relative(Instance.directory, filepath)
              console.error(`[FH] sufficiency-check: ${rel} → ${answer}`)
              log.info("sufficiency-check", { filepath: rel, result: answer })

              return answer.startsWith("YES")
            } catch (e) {
              log.info("sufficiency-check-error", { error: String(e) })
              return false
            }
          }),

        recordRead: (filepath, agent, sessionID) =>
          Effect.sync(() => {
            const basename = path.basename(filepath)
            console.error(`[FH] recordRead: ${basename} (enabled=${state.llmProvider !== null}, pending=${state.pending.has(filepath)})`)
            if (!state.llmProvider) return

            // Track this read for session-level facet pairing (only if facets enabled)
            if (state.facetsEnabled) {
              const recent = state.recentReadsBySession.get(sessionID) ?? []
              if (!recent.includes(filepath)) {
                recent.push(filepath)
                if (recent.length > 16) recent.shift() // bounded
                state.recentReadsBySession.set(sessionID, recent)
              }
            }

            if (state.pending.has(filepath)) return
            state.pending.add(filepath)

            // Generate summary in background using plain Promise (fire-and-forget)
            ;(async () => {
              try {
                const content = await fs.readFile(filepath, "utf-8")
                const hash = crypto.createHash("md5").update(content).digest("hex")
                const rel = path.relative(Instance.directory, filepath)

                // Check in-memory cache first
                const memCached = state.cache.get(filepath)
                if (memCached && memCached.contentHash === hash) {
                  console.error(`[FH] summary-cache-hit (mem): ${rel}`)
                  addSessionEntry(sessionID, memCached)
                  return
                }

                // Check on-disk jsonl for matching hash (sequential mode reuse)
                const existingEntries = await loadEntries(filepath)
                const existing = existingEntries.find(
                  (e) => (e.kind ?? "summary") === "summary" && e.contentHash === hash,
                )
                if (existing) {
                  console.error(`[FH] summary-cache-hit (disk): ${rel}`)
                  state.cache.set(filepath, existing)
                  addSessionEntry(sessionID, existing)
                  // Hydrate facetCache for this hash
                  const facets = existingEntries.filter(
                    (e) => e.kind === "facet" && e.contentHash === hash,
                  )
                  if (facets.length > 0) {
                    state.facetCache.set(`${filepath}::${hash}`, facets)
                  }
                  return
                }

                // No valid cache entry — generate fresh summary
                const prompt = buildSummaryPrompt(filepath, content, state.summaryLong)
                const summary = await callLLM(state, prompt)

                const entry: Entry = {
                  filepath,
                  contentHash: hash,
                  agent,
                  sessionID,
                  operation: "read",
                  summary: summary.trim(),
                  timestamp: Date.now(),
                }

                await appendEntry(entry)
                state.cache.set(filepath, entry)
                addSessionEntry(sessionID, entry)

                console.error(`[FH] summary-generated: ${rel} (${entry.summary.length} chars)`)
                log.info("summary-generated", { filepath: rel, summaryLength: entry.summary.length })
              } catch (e) {
                console.error(`[FH] summary-error: ${filepath} ${String(e)}`)
                log.info("summary-error", { filepath, error: String(e) })
              } finally {
                state.pending.delete(filepath)
              }
            })()
          }),

        getHandoff: (sessionID) =>
          Effect.gen(function* () {
            const entries = sessionEntries.get(sessionID) ?? []
            if (entries.length === 0) return ""
            console.error(`[FH] getHandoff: injecting ${entries.length} entries for session ${sessionID}`)
            return buildHandoffText(entries)
          }),

        getOrGenerateSummary: (filepath, agent, sessionID) =>
          Effect.gen(function* () {
            if (!state.llmProvider) {
              throw new Error("File history not initialized")
            }

            const cached = yield* getEntryEffect(state, filepath)
            const rel = path.relative(Instance.directory, filepath)

            // If we have a base summary, check whether facets exist and need aggregation
            if (cached) {
              const facetKey = `${filepath}::${cached.contentHash}`
              const facets = state.facetsEnabled ? (state.facetCache.get(facetKey) ?? []) : []

              // No facets (or facets disabled): return base summary as-is
              if (facets.length === 0) {
                console.error(`[FH] read_summary: ${rel} (cache hit, no facets)`)
                return { summary: cached.summary, source: "cache" as const }
              }

              // Facets exist: check aggregation cache
              const cachedAgg = state.aggCache.get(facetKey)
              if (cachedAgg && cachedAgg.facetCount === facets.length) {
                console.error(`[FH] read_summary: ${rel} (cache hit, ${facets.length} facets, agg cached)`)
                return { summary: cachedAgg.summary, source: "cache" as const }
              }

              // Aggregate facets + base summary
              const aggregated = yield* Effect.promise(async () => {
                const facetTexts = [cached.summary, ...facets.map((f) => f.summary)]
                const prompt = buildAggregatorPrompt(filepath, facetTexts)
                return (await callLLM(state, prompt)).trim()
              })
              state.aggCache.set(facetKey, { summary: aggregated, facetCount: facets.length })
              console.error(`[FH] read_summary: ${rel} (aggregated ${facets.length} facets + base summary)`)
              return { summary: aggregated, source: "aggregated" as const }
            }

            // No base summary yet: generate synchronously
            const result = yield* Effect.promise(async () => {
              const content = await fs.readFile(filepath, "utf-8")
              const prompt = buildSummaryPrompt(filepath, content, state.summaryLong)
              const summary = (await callLLM(state, prompt)).trim()
              const hash = crypto.createHash("md5").update(content).digest("hex")

              const entry: Entry = {
                filepath,
                contentHash: hash,
                agent,
                sessionID,
                operation: "read",
                summary,
                timestamp: Date.now(),
                kind: "summary",
              }

              await appendEntry(entry)
              state.cache.set(filepath, entry)
              addSessionEntry(sessionID, entry)

              console.error(`[FH] read_summary: ${rel} (cache miss, generated, ${summary.length} chars)`)
              return summary
            })

            return { summary: result, source: "generated" as const }
          }).pipe(Effect.orDie),

        recordObservation: (agentText, agent, sessionID) =>
          Effect.sync(() => {
            if (!state.llmProvider) return
            if (!state.facetsEnabled) return

            const reads = state.recentReadsBySession.get(sessionID) ?? []
            if (reads.length === 0) return

            // Consume the list (clear so each read produces at most one facet per reasoning epoch)
            state.recentReadsBySession.set(sessionID, [])
            console.error(`[FH] recordObservation: pairing reasoning (${agentText.length} chars) with ${reads.length} recent reads`)

            for (const filepath of reads) {
              ;(async () => {
                try {
                  const hash = await getFileHash(filepath)
                  if (!hash) return

                  const facetKey = `${filepath}::${hash}`
                  let existing = state.facetCache.get(facetKey)
                  if (!existing) {
                    // Hydrate from disk on first observation in this session
                    const entries = await loadEntries(filepath)
                    existing = entries.filter(
                      (e) => e.kind === "facet" && e.contentHash === hash,
                    )
                    if (existing.length > 0) {
                      state.facetCache.set(facetKey, existing)
                    }
                  }
                  if (existing.length >= 8) return

                  const baseSummaryEntry = state.cache.get(filepath)
                  const baseSummary = baseSummaryEntry && baseSummaryEntry.contentHash === hash
                    ? baseSummaryEntry.summary
                    : undefined
                  const existingFacetTexts = existing.map((e) => e.summary)
                  const prompt = buildFacetPrompt(filepath, agentText, baseSummary, existingFacetTexts)
                  const raw = (await callLLM(state, prompt)).trim()
                  const rel = path.relative(Instance.directory, filepath)

                  if (raw === "NO_FACET" || raw === "NO_NEW_FACET" || raw.length < 20) {
                    console.error(`[FH] facet skipped: ${rel} (no signal)`)
                    return
                  }

                  const entry: Entry = {
                    filepath,
                    contentHash: hash,
                    agent,
                    sessionID,
                    operation: "read",
                    summary: raw,
                    timestamp: Date.now(),
                    kind: "facet",
                  }

                  await appendEntry(entry)
                  const list = state.facetCache.get(facetKey) ?? []
                  list.push(entry)
                  state.facetCache.set(facetKey, list)
                  state.aggCache.delete(facetKey)
                  console.error(`[FH] facet recorded: ${rel} (#${list.length}, ${raw.length} chars)`)
                } catch (e) {
                  console.error(`[FH] facet extraction failed: ${String(e)}`)
                }
              })()
            }
          }),

        getAllEntries: (sessionID) =>
          Effect.gen(function* () {
            return sessionEntries.get(sessionID) ?? []
          }),
      })
    }),
  )

  export const defaultLayer = layer
}
