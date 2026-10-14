import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type Config, credentials } from "./config.js";
import { AnalysisSchema, TriageId, failure, type Outcome } from "./result.js";
import { COMMANDS, DumpDebugger } from "./windbg.js";
import type { Dump } from "./watcher.js";
import { TriageHistory } from "./history.js";

export async function triage(dump: Dump, config: Config, stop: AbortSignal): Promise<Outcome> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "claude-triage-"));
  const configDir = path.join(workspace, "config");
  await mkdir(configDir);
  const debuggerSession = new DumpDebugger(config.mcpUrl, path.win32.join(config.hostDir, dump.name), dump.kind);
  const history = new TriageHistory(config.reportDir);
  let outcome = failure("The agent returned no result.");
  let cost = 0;
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  stop.addEventListener("abort", abort, { once: true });
  if (stop.aborted) abort();
  const timer = setTimeout(abort, 5 * 60_000);

  try {
    const auth = credentials();
    await debuggerSession.connect();
    const server = createSdkMcpServer({
      name: "windbg", version: "0.1.0", alwaysLoad: true, timeout: 200_000,
      tools: [
        tool("open_dump", "Open this job's assigned crash dump and get initial WinDbg analysis.", {}, async () => ({
          content: [{ type: "text", text: await debuggerSession.open() }],
        })),
        tool("run_command", "Inspect the currently open dump using one of the supported debugger commands.",
          { command: z.enum(COMMANDS) }, async ({ command }) => ({
            content: [{ type: "text", text: await debuggerSession.command(command) }],
          })),
        tool("list_triages", "List existing crash triages with IDs and short summaries.", {}, async () => ({
          content: [{ type: "text", text: JSON.stringify(await history.list()) }],
        })),
        tool("read_triage", "Read an existing Markdown triage before deciding whether this dump matches it.",
          { id: TriageId }, async ({ id }) => ({
            content: [{ type: "text", text: await history.read(id) }],
          })),
      ],
    });
    for await (const message of query({
      prompt: `Triage the assigned ${dump.kind === "kd" ? "kernel" : "user-mode"} crash dump. Use open_dump first. Return the structured report.`,
      options: {
        cwd: workspace,
        systemPrompt: await readFile(new URL("../workflows/triage.md", import.meta.url), "utf8"),
        model: config.model,
        settingSources: [], skills: [], plugins: [], persistSession: false,
        tools: [],
        allowedTools: ["mcp__windbg__open_dump", "mcp__windbg__run_command", "mcp__windbg__list_triages", "mcp__windbg__read_triage"],
        mcpServers: { windbg: server }, strictMcpConfig: true,
        permissionMode: "dontAsk",
        maxTurns: 12, maxBudgetUsd: 2, abortController,
        env: {
          PATH: process.env.PATH,
          // Required by the native process on Windows; absent in the Linux image.
          SystemRoot: process.env.SystemRoot,
          TEMP: workspace, TMP: workspace, TMPDIR: workspace,
          CLAUDE_CONFIG_DIR: configDir,
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          ENABLE_TOOL_SEARCH: "false",
          ...auth,
        },
        outputFormat: { type: "json_schema", schema: z.toJSONSchema(AnalysisSchema, { target: "draft-7" }) },
      },
    })) {
      if (message.type !== "result") continue;
      cost = message.total_cost_usd;
      if (message.subtype !== "success" || message.is_error) {
        const detail = message.subtype === "success" ? message.result : message.errors.join("; ");
        throw new Error(`Claude session failed (${message.subtype}): ${detail}`);
      }
      const analysis = AnalysisSchema.parse(message.structured_output);
      history.validate(analysis);
      if (analysis.status === "success" && (!debuggerSession.opened || analysis.evidence.length === 0)) {
        throw new Error("Claude claimed success without opening the dump and returning debugger evidence.");
      }
      outcome = { ...analysis, cost_usd: cost, debugger_calls: [] };
    }
  } catch (error) {
    outcome = failure(abortController.signal.aborted
      ? "The run was cancelled or exceeded its five-minute time limit."
      : error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    stop.removeEventListener("abort", abort);
    try {
      await debuggerSession.close();
    } catch (error) {
      outcome.status = "failure";
      outcome.triage_match = null;
      outcome.limitations.push(`Debugger cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await rm(workspace, { recursive: true, force: true });
  }
  return { ...outcome, cost_usd: cost, debugger_calls: [...debuggerSession.calls] };
}
