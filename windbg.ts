import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

// The agent can inspect a dump, but cannot run arbitrary debugger scripts or .shell.
export const COMMANDS = ["!analyze -v", ".ecxr", "kv", "kb", "~* kb", "lm", "r", "!peb", "!teb", "!thread", "!process 0 0"] as const;

export class DumpDebugger {
  private client = new Client({ name: "claude-sdk-crash-triage-demo", version: "0.1.0" });
  private transport: StreamableHTTPClientTransport;
  private sessionId?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private openedText?: string;
  readonly calls: string[] = [];

  constructor(url: string, private dumpPath: string, private kind: "cdb" | "kd") {
    this.transport = new StreamableHTTPClientTransport(new URL(url));
  }

  get opened() { return this.openedText !== undefined; }

  async connect() {
    await this.client.connect(this.transport, { timeout: 10_000 });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }

  private async call(name: string, args: Record<string, unknown>, timeout: number): Promise<string> {
    const label = `${name}${args.command ? `: ${args.command}` : ""}`;
    console.log(`[debugger] ${label}`);
    try {
      const result = CallToolResultSchema.parse(await this.client.callTool({ name, arguments: args }, undefined, { timeout }));
      const text = result.content.filter(x => x.type === "text").map(x => x.text).join("\n");
      if (result.isError) throw new Error(text);
      this.calls.push(`${label} (ok)`);
      return text;
    } catch (error) {
      this.calls.push(`${label} (failed)`);
      throw error;
    }
  }

  open(): Promise<string> {
    return this.serialize(async () => {
      if (this.openedText !== undefined) return this.openedText;
      const text = await this.call(`open_${this.kind}_dump`, {
        dump_path: this.dumpPath, timeout_seconds: 180,
        include_stack_trace: true, include_modules: true,
      }, 190_000);
      const match = /^session_id:\s*([a-z]+-[a-z0-9]+)/mi.exec(text);
      if (!match) throw new Error("mcp-windbg returned no session_id. Check the server version.");
      this.sessionId = match[1];
      this.openedText = text;
      return text;
    });
  }

  command(command: string): Promise<string> {
    if (!(COMMANDS as readonly string[]).includes(command)) {
      return Promise.reject(new Error("That debugger command is not enabled for this workflow."));
    }
    return this.serialize(async () => {
      if (!this.sessionId) throw new Error("Call open_dump first.");
      return this.call(`run_${this.kind}_command`, {
        session_id: this.sessionId, command, timeout_seconds: 60,
      }, 70_000);
    });
  }

  async close() {
    // Finish any in-flight open first so an agent timeout cannot lose its session ID.
    await this.queue;
    try {
      if (this.sessionId) {
        await this.call(`close_${this.kind}_session`, { session_id: this.sessionId }, 20_000);
        this.sessionId = undefined;
      }
    } finally {
      // Closing the socket alone does not release the server's HTTP session.
      const timer = setTimeout(() => { void this.transport.close(); }, 5_000);
      try { await this.transport.terminateSession(); }
      finally {
        clearTimeout(timer);
        await this.client.close();
      }
    }
  }
}
