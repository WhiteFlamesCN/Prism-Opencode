import z from "zod"
import { Effect } from "effect"
import * as path from "path"
import { Tool } from "./tool"
import { AppFileSystem } from "../filesystem"
import { FileHistory } from "../file/history"
import DESCRIPTION from "./read_summary.txt"
import { Instance } from "../project/instance"

const parameters = z.object({
  filePath: z.string().describe("The absolute path to the file to summarize"),
})

export const ReadSummaryTool = Tool.define(
  "read_summary",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const history = yield* FileHistory.Service

    const run = Effect.fn("ReadSummaryTool.execute")(function* (
      params: z.infer<typeof parameters>,
      ctx: Tool.Context,
    ) {
      let filepath = params.filePath
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(Instance.directory, filepath)
      }
      if (process.platform === "win32") {
        filepath = AppFileSystem.normalizePath(filepath)
      }
      const title = path.relative(Instance.worktree, filepath)

      if (!history.isEnabled()) {
        return yield* Effect.fail(
          new Error("File summary is not available. Use the `read` tool to read the file directly."),
        )
      }

      const stat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )
      if (!stat) {
        return yield* Effect.fail(new Error(`File not found: ${filepath}`))
      }
      if (stat.type === "Directory") {
        return yield* Effect.fail(new Error(`Cannot summarize a directory: ${filepath}`))
      }

      const result = yield* history.getOrGenerateSummary(filepath, ctx.agent, ctx.sessionID)

      return {
        title: title + " (summary)",
        output: [
          `<path>${filepath}</path>`,
          `<source>file-history ${result.source}</source>`,
          `<summary>`,
          result.summary,
          `</summary>`,
          ``,
          `Note: this is a summary, not full file content. Use the \`read\` tool if you need exact code, line numbers, or to make edits.`,
        ].join("\n"),
        metadata: {
          preview: result.summary.slice(0, 200),
          source: result.source,
          summaryLength: result.summary.length,
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: run,
    }
  }),
)
