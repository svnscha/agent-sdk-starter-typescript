import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { credentials } from "./config.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "claude-hello-"));
const abortController = new AbortController();
const timer = setTimeout(() => abortController.abort(), 60_000);

try {
  let completed = false;
  for await (const message of query({
    prompt: "Reply with exactly: Hello from a programmable Claude session.",
    options: {
      model: process.env.CLAUDE_MODEL ?? "sonnet",
      cwd: workspace,
      settingSources: [], skills: [], plugins: [], persistSession: false,
      tools: [], mcpServers: {}, strictMcpConfig: true,
      permissionMode: "dontAsk",
      maxTurns: 3, maxBudgetUsd: 0.25, abortController,
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        TEMP: workspace, TMP: workspace, TMPDIR: workspace,
        CLAUDE_CONFIG_DIR: workspace,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        ...credentials(),
      },
    },
  })) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success" || message.is_error) {
      const detail = message.subtype === "success" ? message.result : message.errors.join("; ");
      throw new Error(`Claude session failed (${message.subtype}): ${detail}`);
    }
    console.log(message.result);
    completed = true;
  }
  if (!completed) throw new Error("Claude returned no final result.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await rm(workspace, { recursive: true, force: true });
}
