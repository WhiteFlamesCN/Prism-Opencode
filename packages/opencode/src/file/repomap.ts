import { promises as fs } from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { Language, Parser, type Node } from "web-tree-sitter"
import { lazy } from "@/util/lazy"
import { Log } from "@/util/log"

export namespace RepoMap {
  const log = Log.create({ service: "file.repomap" })

  const IGNORE_DIRS = new Set([
    ".git",
    ".hg",
    ".svn",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".nox",
    "node_modules",
    ".venv",
    "venv",
    "env",
    "build",
    "dist",
    ".eggs",
    ".idea",
    ".vscode",
    "target",
    "site-packages",
  ])

  const SUFFIX_PY = ".py"

  const resolveWasm = (asset: string) => {
    if (asset.startsWith("file://")) return fileURLToPath(asset)
    if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
    const url = new URL(asset, import.meta.url)
    return fileURLToPath(url)
  }

  const parser = lazy(async () => {
    const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
      with: { type: "wasm" },
    })
    const treePath = resolveWasm(treeWasm)
    await Parser.init({
      locateFile() {
        return treePath
      },
    })
    const { default: pyWasm } = await import("tree-sitter-python/tree-sitter-python.wasm" as string, {
      with: { type: "wasm" },
    })
    const pyPath = resolveWasm(pyWasm)
    const pyLanguage = await Language.load(pyPath)
    const py = new Parser()
    py.setLanguage(pyLanguage)
    return { py }
  })

  type Symbol = {
    kind: "class" | "function" | "method"
    name: string
    sig: string
    line: number
    indent: number
  }

  function nodeText(src: string, n: Node): string {
    return src.slice(n.startIndex, n.endIndex)
  }

  function extractSig(src: string, n: Node, maxLen = 200): string {
    const text = nodeText(src, n)
    const colon = text.indexOf(":")
    const head = colon >= 0 ? text.slice(0, colon) : text
    const oneLine = head.replace(/\s+/g, " ").trim()
    return oneLine.length > maxLen ? oneLine.slice(0, maxLen - 1) + "…" : oneLine
  }

  function walkSymbols(
    src: string,
    node: Node,
    indent: number,
    out: Symbol[],
    parentClass: boolean,
  ): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (!child) continue
      const t = child.type
      if (t === "decorated_definition") {
        const inner = child.childForFieldName("definition")
        if (inner) {
          walkSymbols(src, child, indent, out, parentClass)
        }
        continue
      }
      if (t === "class_definition") {
        const nameNode = child.childForFieldName("name")
        const name = nameNode ? nodeText(src, nameNode) : "?"
        out.push({
          kind: "class",
          name,
          sig: extractSig(src, child),
          line: child.startPosition.row + 1,
          indent,
        })
        const body = child.childForFieldName("body")
        if (body) walkSymbols(src, body, indent + 1, out, true)
        continue
      }
      if (t === "function_definition") {
        const nameNode = child.childForFieldName("name")
        const name = nameNode ? nodeText(src, nameNode) : "?"
        out.push({
          kind: parentClass ? "method" : "function",
          name,
          sig: extractSig(src, child),
          line: child.startPosition.row + 1,
          indent,
        })
        continue
      }
      if (t === "block" || t === "module") {
        walkSymbols(src, child, indent, out, parentClass)
      }
    }
  }

  async function listPyFiles(root: string): Promise<string[]> {
    const results: string[] = []
    async function walk(dir: string): Promise<void> {
      let entries: import("fs").Dirent[]
      try {
        entries = (await fs.readdir(dir, { withFileTypes: true })) as unknown as import("fs").Dirent[]
      } catch {
        return
      }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (IGNORE_DIRS.has(e.name)) continue
          if (e.name.endsWith(".egg-info")) continue
          await walk(full)
        } else if (e.isFile() && e.name.endsWith(SUFFIX_PY)) {
          results.push(full)
        }
      }
    }
    await walk(root)
    results.sort()
    return results
  }

  async function buildFileBlock(p: Parser, root: string, file: string): Promise<string | null> {
    let src: string
    try {
      src = await fs.readFile(file, "utf8")
    } catch {
      return null
    }
    if (src.length === 0) return null
    if (src.length > 800_000) return null
    let tree
    try {
      tree = p.parse(src)
    } catch (e) {
      log.warn("parse failed", { file, error: String(e) })
      return null
    }
    if (!tree) return null
    const symbols: Symbol[] = []
    walkSymbols(src, tree.rootNode, 0, symbols, false)
    if (symbols.length === 0) return null
    const rel = path.relative(root, file)
    const lines: string[] = [`${rel}:`]
    for (const s of symbols) {
      const pad = "  ".repeat(s.indent + 1)
      lines.push(`${pad}${s.sig}  [L${s.line}]`)
    }
    return lines.join("\n")
  }

  function approxTokens(s: string): number {
    return Math.ceil(s.length / 4)
  }

  type Cached = { dir: string; text: string | undefined }
  let cache: Cached | undefined

  export async function generate(root: string): Promise<string | undefined> {
    if (process.env.OPENCODE_REPO_MAP !== "1") return undefined
    if (cache && cache.dir === root) return cache.text
    const maxTokens = parseInt(process.env.OPENCODE_REPO_MAP_MAX_TOKENS ?? "4096", 10) || 4096
    const start = Date.now()
    try {
      const { py } = await parser()
      const files = await listPyFiles(root)
      if (files.length === 0) {
        log.info("repo-map: no python files", { root })
        cache = { dir: root, text: undefined }
        return undefined
      }
      const header = [
        "<repo-map>",
        "Static repository index (Python only, tree-sitter extracted, no LLM).",
        "Format: <relative-path>: then indented symbol signatures with line numbers.",
        "",
      ].join("\n")
      const footer = "</repo-map>"
      const budget = maxTokens
      let used = approxTokens(header) + approxTokens(footer)
      const blocks: string[] = []
      let included = 0
      let omitted = 0
      for (const f of files) {
        const block = await buildFileBlock(py, root, f)
        if (!block) continue
        const cost = approxTokens(block) + 1
        if (used + cost > budget) {
          omitted = files.length - included
          break
        }
        blocks.push(block)
        used += cost
        included++
      }
      const tail =
        omitted > 0
          ? `\n[... ${omitted} more files omitted (token budget ${budget} reached) ...]`
          : ""
      const text = header + blocks.join("\n\n") + tail + "\n" + footer
      const ms = Date.now() - start
      log.info("repo-map generated", {
        root,
        files: files.length,
        included,
        omitted,
        tokens: used,
        ms,
      })
      cache = { dir: root, text }
      return text
    } catch (e) {
      log.warn("repo-map generation failed", { root, error: String(e) })
      return undefined
    }
  }
}
