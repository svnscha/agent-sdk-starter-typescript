import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { DumpDebugger } from "./windbg.js";

// Exercise the real transport and debugger without making a model request.
const config = loadConfig();
const name = process.argv[2];
if (!name || path.win32.basename(name) !== name || path.posix.basename(name) !== name) {
  throw new Error("Usage: npm run check:mcp -- <dump-filename> [--kernel]");
}
const debuggerSession = new DumpDebugger(config.mcpUrl, path.win32.join(config.hostDir, name), process.argv.includes("--kernel") ? "kd" : "cdb");
try {
  await debuggerSession.connect();
  const output = await debuggerSession.open();
  const stack = await debuggerSession.command("kv");
  await mkdir(config.reportDir, { recursive: true });
  await writeFile(path.join(config.reportDir, "mcp-check.txt"), output + "\n" + stack);
  console.log("Real MCP open and stack inspection succeeded. Evidence saved to reports/mcp-check.txt. No Claude request was made.");
} finally {
  await debuggerSession.close();
}
