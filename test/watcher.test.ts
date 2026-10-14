import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FolderWatcher } from "../watcher.js";
import { credentials } from "../config.js";
import { failure, type Outcome, type Report } from "../result.js";

const success: Outcome = {
  status: "success", summary: "A test crash was investigated.", findings: ["Access violation"],
  evidence: [{ command: "!analyze -v", observation: "Exception c0000005" }],
  limitations: [], next_steps: [], cost_usd: 0, debugger_calls: ["open_cdb_dump (ok)"],
  triage_match: null,
};

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-demo-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dumps = path.join(root, "dumps");
  const reports = path.join(root, "reports");
  await mkdir(dumps);
  const records = async () => Promise.all((await readdir(reports)).filter(x => x.endsWith(".json")).map(async x => JSON.parse(await readFile(path.join(reports, x), "utf8")) as Report));
  return { dumps, reports, records, watcher: new FolderWatcher(dumps, reports, 10) };
}

test("a growing dump waits, produces two files, and is skipped after a restart", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.dumps, "crash.DMP"), "MDMP");
  await writeFile(path.join(f.dumps, "copy.dmp.partial"), "not ready");
  let calls = 0;
  const run = async () => { calls++; return success; };
  assert.equal((await f.watcher.tick(run, 0)).pending, 1);
  await appendFile(path.join(f.dumps, "crash.DMP"), "more bytes");
  assert.equal((await f.watcher.tick(run, 10)).processed, 0);
  assert.equal((await f.watcher.tick(run, 19)).processed, 0);
  assert.equal((await f.watcher.tick(run, 20)).processed, 1);
  assert.equal(calls, 1);
  assert.equal((await f.records())[0].status, "success");
  const files = await readdir(f.reports);
  assert.equal(files.filter(x => x.endsWith(".json") || x.endsWith(".md")).length, 2);
  assert.match(await readFile(path.join(f.reports, files.find(x => x.endsWith(".md"))!), "utf8"), /Status: \*\*success\*\*/);
  const restarted = new FolderWatcher(f.dumps, f.reports, 10);
  assert.equal((await restarted.tick(run, 30)).processed, 0);
  assert.equal(calls, 1);
});

test("failed dumps get failure reports and do not retry on every poll", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.dumps, "broken.dmp"), "bad dump");
  let calls = 0;
  const run = async () => { calls++; throw new Error("Debugger offline"); };
  await f.watcher.tick(run, 0);
  assert.equal((await f.watcher.tick(run, 10)).failures, 1);
  assert.equal((await f.watcher.tick(run, 20)).failures, 1);
  assert.equal(calls, 1);
  assert.equal((await f.records())[0].summary, "Debugger offline");
});

test("a result is discarded if the input changes during analysis", async t => {
  const f = await fixture(t);
  const filename = path.join(f.dumps, "changing.dmp");
  await writeFile(filename, "MDMP");
  await f.watcher.tick(async () => success, 0);
  const changed = await f.watcher.tick(async () => { await appendFile(filename, "new"); return success; }, 10);
  assert.equal(changed.pending, 1);
  assert.equal((await f.records()).length, 0);
  await f.watcher.tick(async () => success, 20);
  assert.equal((await f.watcher.tick(async () => success, 30)).processed, 1);
});

test("kernel headers select KD and existing filenames with new contents get a new result", async t => {
  const f = await fixture(t);
  const filename = path.join(f.dumps, "kernel.dmp");
  await writeFile(filename, "PAGEDU64");
  const run = async (dump: { kind: string }) => { assert.equal(dump.kind, "kd"); return success; };
  await f.watcher.tick(run, 0);
  await f.watcher.tick(run, 10);
  await appendFile(filename, "changed");
  await f.watcher.tick(run, 20);
  await f.watcher.tick(run, 30);
  assert.equal((await f.records()).length, 2);
});

test("cancellation does not mark unstarted dumps as failed", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.dumps, "a.dmp"), "MDMP");
  await writeFile(path.join(f.dumps, "b.dmp"), "MDMP");
  const controller = new AbortController();
  await f.watcher.tick(async () => success, 0);
  await f.watcher.tick(async () => { controller.abort(); return failure("Cancelled"); }, 10, controller.signal);
  assert.equal((await f.records()).length, 1);
});

test("authentication requires one explicit credential", () => {
  assert.throws(() => credentials({}), /exactly one/);
  assert.throws(() => credentials({ CLAUDE_CODE_OAUTH_TOKEN: "a", ANTHROPIC_API_KEY: "b" }), /exactly one/);
  assert.deepEqual(credentials({ CLAUDE_CODE_OAUTH_TOKEN: "token" }), { CLAUDE_CODE_OAUTH_TOKEN: "token" });
});
