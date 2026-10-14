import test from "node:test";
import assert from "node:assert/strict";
import { DumpDebugger } from "../windbg.js";
import { AnalysisSchema } from "../result.js";

test("arbitrary and chained debugger commands are rejected before contacting MCP", async () => {
  const session = new DumpDebugger("http://127.0.0.1:1/mcp/", "C:\\dumps\\test.dmp", "cdb");
  for (const command of [".shell whoami", "kv; .shell whoami", "g", ".opendump C:\\other.dmp"]) {
    await assert.rejects(session.command(command), /not enabled/);
  }
  assert.equal(session.calls.length, 0);
  await assert.rejects(session.command("kv"), /open_dump first/);
});

test("free text and invented statuses cannot pass structured result validation", () => {
  assert.equal(AnalysisSchema.safeParse("Everything looks fine").success, false);
  assert.equal(AnalysisSchema.safeParse({
    status: "probably fine", summary: "Done", findings: [], evidence: [], limitations: [], next_steps: [],
  }).success, false);
});
