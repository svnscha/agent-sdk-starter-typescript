import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type Outcome, type Report, failure, markdown } from "./result.js";
import { TriageHistory } from "./history.js";

export type Dump = { name: string; fingerprint: string; kind: "cdb" | "kd" };
type Seen = { fingerprint: string; unchangedSince: number };

export class FolderWatcher {
  private seen = new Map<string, Seen>();

  constructor(private dumpDir: string, private reportDir: string, private stableMs = 10_000) {}

  private async scan() {
    const files = await readdir(this.dumpDir, { withFileTypes: true });
    const dumps = [];
    for (const file of files) {
      if (!file.isFile() || !/\.(dmp|mdmp|hdmp)$/i.test(file.name)) continue;
      try {
        const info = await stat(path.join(this.dumpDir, file.name));
        const fingerprint = createHash("sha256").update(JSON.stringify([file.name, info.size, info.mtimeMs])).digest("hex").slice(0, 16);
        dumps.push({ name: file.name, fingerprint });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return dumps.sort((a, b) => a.name.localeCompare(b.name));
  }

  private stem(dump: { name: string; fingerprint: string }) {
    const safeName = dump.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
    return path.join(this.reportDir, `${safeName}-${dump.fingerprint}`);
  }

  async tick(run: (dump: Dump) => Promise<Outcome>, now = Date.now(), signal?: AbortSignal) {
    await mkdir(this.reportDir, { recursive: true });
    const history = new TriageHistory(this.reportDir);
    const dumps = await this.scan();
    const present = new Set(dumps.map(d => d.name));
    for (const name of this.seen.keys()) if (!present.has(name)) this.seen.delete(name);
    let pending = 0;
    let failures = 0;
    let processed = 0;
    for (const dump of dumps) {
      if (signal?.aborted) break;
      const stem = this.stem(dump);
      let existing: Report | undefined;
      try {
        const saved = JSON.parse(await readFile(`${stem}.json`, "utf8")) as Report;
        await stat(`${stem}.md`);
        if (saved.fingerprint === dump.fingerprint && ["success", "failure"].includes(saved.status)) existing = saved;
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing) {
        if (existing.status === "failure") failures++;
        // Resume an interrupted history write without another model call.
        if (existing.schema_version === 2) await history.record(existing, path.basename(`${stem}.md`));
        continue;
      }
      const previous = this.seen.get(dump.name);
      if (!previous || previous.fingerprint !== dump.fingerprint) {
        this.seen.set(dump.name, { fingerprint: dump.fingerprint, unchangedSince: now });
        pending++;
        continue;
      }
      if (now - previous.unchangedSince < this.stableMs) { pending++; continue; }

      const started = new Date().toISOString();
      console.log(`[triage] Starting ${dump.name}`);
      let outcome: Outcome;
      try {
        const file = await open(path.join(this.dumpDir, dump.name), "r");
        const header = Buffer.alloc(4);
        try { await file.read(header, 0, 4, 0); } finally { await file.close(); }
        outcome = await run({ ...dump, kind: header.toString() === "PAGE" ? "kd" : "cdb" });
      } catch (error) {
        outcome = failure(error instanceof Error ? error.message : String(error));
      }
      // Do not commit a result for a file that changed while the debugger was using it.
      const current = (await this.scan()).find(x => x.name === dump.name);
      if (current?.fingerprint !== dump.fingerprint) {
        this.seen.delete(dump.name);
        pending++;
        console.log(`[triage] ${dump.name} changed during analysis; waiting for a stable copy.`);
        continue;
      }
      const report: Report = {
        ...outcome, schema_version: 2, dump: dump.name, fingerprint: dump.fingerprint,
        triage_id: outcome.status === "success" ? outcome.triage_match?.id ?? dump.fingerprint : null,
        started_at: started, finished_at: new Date().toISOString(),
      };
      await writeFile(`${stem}.md.tmp`, markdown(report));
      await rename(`${stem}.md.tmp`, `${stem}.md`);
      await writeFile(`${stem}.json.tmp`, JSON.stringify(report, null, 2) + "\n");
      await rename(`${stem}.json.tmp`, `${stem}.json`);
      await history.record(report, path.basename(`${stem}.md`));
      if (outcome.status === "failure") failures++;
      processed++;
      console.log(`[triage] ${dump.name}: ${outcome.status}`);
    }
    return { pending, failures, processed };
  }
}

export async function watch(watcher: FolderWatcher, run: (dump: Dump) => Promise<Outcome>, once: boolean, signal: AbortSignal) {
  do {
    const result = await watcher.tick(run, Date.now(), signal);
    if (once && result.pending === 0) return result.failures === 0 ? 0 : 1;
    await delay(2_000, undefined, { signal }).catch(error => {
      if (!signal.aborted) throw error;
    });
  } while (!signal.aborted);
  return 0;
}
