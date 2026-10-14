import { z } from "zod";

export const TriageId = z.string().regex(/^[a-f0-9]{16}$/);

export const AnalysisSchema = z.object({
  status: z.enum(["success", "failure"]),
  summary: z.string().min(1),
  findings: z.array(z.string()),
  evidence: z.array(z.object({ command: z.string(), observation: z.string() }).strict()),
  limitations: z.array(z.string()),
  next_steps: z.array(z.string()),
  triage_match: z.object({ id: TriageId, reason: z.string().trim().min(1) }).strict().nullable(),
}).strict();

export type Analysis = z.infer<typeof AnalysisSchema>;
export type Outcome = Analysis & { cost_usd: number; debugger_calls: string[] };
export type Report = Outcome & {
  schema_version: 2;
  triage_id: string | null;
  dump: string;
  fingerprint: string;
  started_at: string;
  finished_at: string;
};

export function failure(message: string): Outcome {
  return {
    status: "failure", summary: message, findings: [], evidence: [],
    limitations: ["This run did not complete crash triage."],
    next_steps: ["Fix the reported problem, then remove this dump's report pair to retry."],
    triage_match: null, cost_usd: 0, debugger_calls: [],
  };
}

export function markdown(report: Report): string {
  const bullets = (items: string[]) => items.length ? items.map(x => `- ${x}`).join("\n") : "None reported.";
  return [
    `# Crash triage: ${report.dump}`, "",
    `- Status: **${report.status}**`,
    `- Completed: ${report.finished_at}`,
    `- Estimated model cost: $${report.cost_usd.toFixed(4)}`, "",
    "## Summary", "", report.summary, "",
    "## Findings", "", bullets(report.findings), "",
    "## Debugger evidence", "",
    bullets(report.evidence.map(x => `**${x.command}**: ${x.observation}`)), "",
    "## Limitations", "", bullets(report.limitations), "",
    "## Next steps", "", bullets(report.next_steps), "",
    "## Shared triage", "",
    report.triage_id ? `[${report.triage_id}](triages/${report.triage_id}.md)` : "Not grouped: this run failed.", "",
    report.triage_match?.reason ?? (report.triage_id ? "Created a new triage." : ""), "",
    "## Calls recorded by the runner", "", bullets(report.debugger_calls), "",
    "Success means triage completed with debugger evidence. It does not mean the root cause is proven.", "",
  ].join("\n");
}
