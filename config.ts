import path from "node:path";

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const hostDir = env.DUMP_HOST_DIR?.trim();
  if (!hostDir || !path.win32.isAbsolute(hostDir)) {
    throw new Error("Set DUMP_HOST_DIR in .env to the full Windows path of the dumps folder.");
  }
  return {
    dumpDir: path.resolve(env.DUMP_DIR ?? "dumps"),
    reportDir: path.resolve(env.REPORT_DIR ?? "reports"),
    hostDir,
    mcpUrl: new URL(env.MCP_WINDBG_URL ?? "http://host.docker.internal:8000/mcp/").href,
    model: env.CLAUDE_MODEL ?? "sonnet",
  };
}

export type Config = ReturnType<typeof loadConfig>;

export function credentials(env: NodeJS.ProcessEnv = process.env) {
  const token = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (Boolean(token) === Boolean(key)) {
    throw new Error("Set exactly one of CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in .env.");
  }
  return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : { ANTHROPIC_API_KEY: key! };
}
