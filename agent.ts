import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  query,
  type Options,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

export async function runAgent(
  prompt: string,
  options: Options = {},
  onResult?: (result: SDKResultMessage) => void,
) {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (Boolean(token) === Boolean(key))
    throw new Error("Set exactly one Claude credential in .env.");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-sdk-"));
  const controller = options.abortController ?? new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  try {
    for await (const message of query({
      prompt,
      options: {
        model: process.env.CLAUDE_MODEL ?? "sonnet",
        cwd: workspace,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        permissionMode: "dontAsk",
        settingSources: [],
        skills: [],
        plugins: [],
        persistSession: false,
        maxTurns: 12,
        maxBudgetUsd: 2,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: workspace,
          TMP: workspace,
          TMPDIR: workspace,
          CLAUDE_CONFIG_DIR: workspace,
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          ...(token
            ? { CLAUDE_CODE_OAUTH_TOKEN: token }
            : { ANTHROPIC_API_KEY: key! }),
        },
        ...options,
        abortController: controller,
      },
    })) {
      if (message.type !== "result") continue;
      onResult?.(message);
      if (message.subtype !== "success" || message.is_error) {
        throw new Error(
          message.subtype === "success"
            ? message.result
            : message.errors.join("; "),
        );
      }
      return message.structured_output ?? message.result;
    }
    throw new Error("The agent returned no result.");
  } finally {
    clearTimeout(timer);
    await rm(workspace, { recursive: true, force: true });
  }
}

if (import.meta.main)
  console.log(await runAgent("Reply with: Hello from the Agent SDK."));
