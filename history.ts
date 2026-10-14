import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { TriageId, type Analysis, type Report } from "./result.js";

export class TriageHistory {
  private directory: string;
  private listed = false;
  private readIds = new Set<string>();

  constructor(reportDir: string) {
    this.directory = path.join(reportDir, "triages");
  }

  private filename(id: string) {
    return path.join(this.directory, `${TriageId.parse(id)}.md`);
  }

  private async load(id: string) {
    const filename = this.filename(id);
    if (!(await lstat(filename)).isFile()) throw new Error("A triage must be a regular Markdown file.");
    return readFile(filename, "utf8");
  }

  async list() {
    console.log("[history] list_triages");
    const files = await readdir(this.directory, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [];
    });
    const entries = [];
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || !/^[a-f0-9]{16}\.md$/.test(file.name)) continue;
      const id = file.name.slice(0, -3);
      const markdown = await this.load(id);
      entries.push({ id, summary: (markdown.split("\n\n")[1] ?? "").slice(0, 600) });
    }
    this.listed = true;
    return entries;
  }

  async read(id: string) {
    console.log(`[history] read_triage: ${TriageId.parse(id)}`);
    const markdown = await this.load(id);
    this.readIds.add(id);
    return markdown;
  }

  validate(analysis: Analysis) {
    if (analysis.status === "failure") {
      if (analysis.triage_match) throw new Error("A failed investigation cannot match a triage.");
      return;
    }
    if (!this.listed) throw new Error("Claude claimed success without checking triage history.");
    if (analysis.triage_match && !this.readIds.has(analysis.triage_match.id)) {
      throw new Error("Claude selected a triage without reading it.");
    }
  }

  // Called only by the single watcher, after the individual report is committed.
  async record(report: Report, reportName: string) {
    if (report.status !== "success") return;
    const id = report.triage_match?.id ?? report.fingerprint;
    if (report.triage_id !== id) throw new Error("Report has an inconsistent triage ID.");
    const filename = this.filename(id);
    let markdown: string;
    try {
      markdown = await this.load(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || report.triage_match) throw error;
      markdown = [
        `# Triage ${id}`, "", report.summary, "",
        "## Initial findings", "", ...report.findings.map(x => `- ${x}`), "",
        "## Initial debugger evidence", "",
        ...report.evidence.map(x => `- **${x.command}**: ${x.observation}`), "",
        "## Initial limitations", "", ...report.limitations.map(x => `- ${x}`), "",
        "## Occurrences", "",
      ].join("\n");
    }
    const marker = `<!-- occurrence:${report.fingerprint} -->`;
    if (markdown.includes(marker)) return;
    markdown += [
      "", marker, `### ${report.finished_at}`, "",
      `[${report.fingerprint}](../${encodeURIComponent(reportName)})`, "",
      report.summary, "",
      `Match: ${report.triage_match?.reason ?? "First occurrence; created this triage."}`, "",
    ].join("\n");
    await mkdir(this.directory, { recursive: true });
    await writeFile(`${filename}.tmp`, markdown);
    await rename(`${filename}.tmp`, filename);
  }
}
