import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  query,
  type Options,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

export function log(scope: string, text: string) {
  for (const line of text.trimEnd().split(/\r?\n/)) {
    console.log(`[${new Date().toISOString()}] [${scope}] ${line}`);
  }
}

export async function runAgent(
  prompt: string,
  options: Options = {},
  onResult?: (result: SDKResultMessage) => void,
) {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (Boolean(token) === Boolean(key)) {
    throw new Error("Set exactly one Claude credential in .env.");
  }

  const model = process.env.CLAUDE_MODEL ?? "sonnet";
  // Keep each session's workspace and Claude config separate from personal settings.
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-sdk-"));
  const controller = options.abortController ?? new AbortController();
  const started = Date.now();
  let output = "";
  const flush = (complete = true) => {
    const end = complete
      ? output.length
      : Math.max(output.lastIndexOf(" "), output.lastIndexOf("\n")) + 1;
    if (end > 0) {
      log("agent.text", output.slice(0, end));
      output = output.slice(end);
    }
  };
  // Batch text deltas so Docker logs stay readable without waiting for a full reply.
  const streamTimer = setInterval(() => flush(false), 1_000);
  const timer = setTimeout(() => {
    log("agent.timeout", "Session exceeded five minutes; stopping.");
    controller.abort();
  }, 300_000);
  log("agent.start", `model=${options.model ?? model}`);
  try {
    for await (const message of query({
      prompt,
      options: {
        model,
        cwd: workspace,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        permissionMode: "dontAsk",
        settingSources: [],
        skills: [],
        plugins: [],
        persistSession: false,
        includePartialMessages: true,
        stderr: (text) => log("agent.stderr", text),
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
      if (message.type === "system" && message.subtype === "init") {
        log(
          "agent.ready",
          `session=${message.session_id} model=${message.model}`,
        );
      } else if (message.type === "system" && message.subtype === "api_retry") {
        log(
          "agent.retry",
          `attempt=${message.attempt}/${message.max_retries} status=${message.error_status} error=${message.error} waitMs=${message.retry_delay_ms}`,
        );
      } else if (message.type === "stream_event") {
        const event = message.event;
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          output += event.delta.text;
        } else if (event.type === "content_block_stop") {
          flush();
        }
      } else if (message.type === "assistant") {
        flush();
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            log(
              "tool.start",
              `${block.name} id=${block.id} ${JSON.stringify(block.input).slice(0, 500)}`,
            );
          } else if (
            block.type === "text" &&
            options.includePartialMessages === false
          ) {
            log("agent.text", block.text);
          }
        }
      } else if (
        message.type === "user" &&
        Array.isArray(message.message.content)
      ) {
        for (const block of message.message.content) {
          if (block.type === "tool_result") {
            log(
              "tool.stop",
              `id=${block.tool_use_id} status=${block.is_error ? "error" : "success"}` +
                (block.is_error
                  ? ` detail=${JSON.stringify(block.content).slice(0, 500)}`
                  : ""),
            );
          }
        }
      } else if (message.type === "tool_progress") {
        log(
          "tool.progress",
          `${message.tool_name} elapsed=${message.elapsed_time_seconds}s`,
        );
      }
      if (message.type !== "result") {
        continue;
      }

      flush();
      log(
        "agent.result",
        `status=${message.subtype} isError=${message.is_error} turns=${message.num_turns} durationMs=${message.duration_ms}`,
      );
      // Failed sessions can still incur cost, so report usage before throwing.
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
  } catch (error) {
    log("agent.error", String(error));
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(streamTimer);
    flush();
    await rm(workspace, { recursive: true, force: true });
    log(
      "agent.stop",
      `elapsedMs=${Date.now() - started} aborted=${controller.signal.aborted}`,
    );
  }
}

if (import.meta.main) {
  log(
    "result",
    String(await runAgent("Reply with: Hello from the Agent SDK.")),
  );
}
