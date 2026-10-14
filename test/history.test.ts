import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TriageHistory } from "../history.js";
import { FolderWatcher } from "../watcher.js";
import { AnalysisSchema, failure, type Outcome, type Report } from "../result.js";

const success: Outcome = {
  status: "success", summary: "Null-pointer write in DemoCrash1+0x1ee4.",
  findings: ["Access violation c0000005"],
  evidence: [{ command: "kv", observation: "DemoCrash1+0x1ee4" }],
  limitations: [], next_steps: [], triage_match: null, cost_usd: 0, debugger_calls: [],
};

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-history-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dumps = path.join(root, "dumps");
  const reports = path.join(root, "reports");
  await mkdir(dumps);
  const history = new TriageHistory(reports);
  const watcher = new FolderWatcher(dumps, reports, 0);
  const add = async (name: string, outcome: Outcome) => {
    await writeFile(path.join(dumps, name), "MDMP");
    await watcher.tick(async () => outcome);
    return watcher.tick(async () => outcome);
  };
  return { root, dumps, reports, history, watcher, add };
}

test("different dumps can share a Markdown triage while an unrelated result stays separate", async t => {
  const f = await fixture(t);
  await f.add("first.dmp", success);
  const [first] = await f.history.list();
  assert.match(await f.history.read(first.id), /DemoCrash1\+0x1ee4/);
  const match = { ...success, triage_match: { id: first.id, reason: "Same null write, module offset and compatible build." } };
  f.history.validate(match);
  await f.add("second.dmp", match);
  await f.add("unrelated.dmp", { ...success, summary: "Read access violation in OtherApp+0x234.",
    evidence: [{ command: "kv", observation: "OtherApp+0x234" }] });
  assert.equal((await f.history.list()).length, 2);
  const markdown = await f.history.read(first.id);
  assert.equal(markdown.match(/<!-- occurrence:/g)?.length, 2);
  assert.match(markdown, /Same null write, module offset and compatible build/);
  const files = await readdir(f.reports);
  assert.equal(files.filter(x => x.endsWith(".md")).length, 3);
  const second = JSON.parse(await readFile(path.join(f.reports, files.find(x => x.startsWith("second") && x.endsWith(".json"))!), "utf8")) as Report;
  assert.equal(second.triage_id, first.id);
  let reruns = 0;
  await new FolderWatcher(f.dumps, f.reports, 0).tick(async () => { reruns++; return success; });
  assert.equal(reruns, 0);
  assert.equal(await f.history.read(first.id), markdown);
});

test("history publication recovers after a write failure without rerunning the agent", async t => {
  const f = await fixture(t);
  await mkdir(f.reports);
  // A file blocks creation of the history directory after the report is saved.
  await writeFile(path.join(f.reports, "triages"), "blocked");
  await assert.rejects(f.add("recover.dmp", success));
  assert.equal((await readdir(f.reports)).filter(x => x.endsWith(".json")).length, 1);
  await rm(path.join(f.reports, "triages"));
  const restarted = new FolderWatcher(f.dumps, f.reports, 0);
  let reruns = 0;
  const run = async () => { reruns++; return success; };
  await restarted.tick(run);
  const [entry] = await f.history.list();
  const saved = await f.history.read(entry.id);
  await restarted.tick(run);
  assert.equal(reruns, 0);
  assert.equal(await f.history.read(entry.id), saved);
  assert.equal(saved.match(/<!-- occurrence:/g)?.length, 1);
});

test("history rejects unknown IDs, paths, and matches the agent has not read", async t => {
  const f = await fixture(t);
  assert.throws(() => f.history.validate(success), /without checking/);
  await f.add("first.dmp", success);
  const [entry] = await f.history.list();
  const match = { ...success, triage_match: { id: entry.id, reason: "Matching frames" } };
  assert.throws(() => f.history.validate(match), /without reading/);
  for (const id of ["../outside", "..\\outside", "C:\\outside", "a".repeat(17)]) {
    await assert.rejects(f.history.read(id));
  }
  await assert.rejects(f.history.read("0".repeat(16)), { code: "ENOENT" });
  await f.history.read(entry.id);
  assert.doesNotThrow(() => f.history.validate(match));
  assert.throws(() => f.history.validate({ ...match, status: "failure" }), /failed investigation/);
  assert.equal(AnalysisSchema.safeParse({ ...match, triage_match: { id: entry.id, reason: " " } }).success, false);
});

test("failures and results from changing dumps never enter shared history", async t => {
  const f = await fixture(t);
  await f.add("broken.dmp", failure("Bad dump"));
  assert.deepEqual(await f.history.list(), []);
  await writeFile(path.join(f.dumps, "changing.dmp"), "MDMP");
  await f.watcher.tick(async () => success);
  await f.watcher.tick(async () => {
    await writeFile(path.join(f.dumps, "changing.dmp"), "changed during analysis");
    return success;
  });
  assert.deepEqual(await f.history.list(), []);
});

test("older reports remain readable and skipped without fabricating history", async t => {
  const f = await fixture(t);
  await f.add("old.dmp", success);
  const filename = (await readdir(f.reports)).find(x => x.endsWith(".json"))!;
  const saved = JSON.parse(await readFile(path.join(f.reports, filename), "utf8"));
  delete saved.triage_match;
  delete saved.triage_id;
  saved.schema_version = 1;
  await writeFile(path.join(f.reports, filename), JSON.stringify(saved));
  await rm(path.join(f.reports, "triages"), { recursive: true });
  let reruns = 0;
  await new FolderWatcher(f.dumps, f.reports, 0).tick(async () => { reruns++; return success; });
  assert.equal(reruns, 0);
  assert.deepEqual(await f.history.list(), []);
});
