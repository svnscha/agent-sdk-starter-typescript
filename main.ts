import { loadConfig, credentials } from "./config.js";
import { triage } from "./agent.js";
import { FolderWatcher, watch } from "./watcher.js";

try {
  const args = process.argv.slice(2);
  if (args.some(x => x !== "--once")) throw new Error("Usage: npm start -- [--once]");
  const config = loadConfig();
  credentials();
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  console.log(`Watching ${config.dumpDir}; reports go to ${config.reportDir}.`);
  process.exitCode = await watch(
    new FolderWatcher(config.dumpDir, config.reportDir),
    dump => triage(dump, config, controller.signal),
    args.includes("--once"), controller.signal,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
