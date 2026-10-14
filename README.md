# Automatic crash triage with Claude and mcp-windbg

Drop a Windows crash dump into `dumps`. This demo asks Claude to investigate it
through [mcp-windbg](https://github.com/svnscha/mcp-windbg), then writes a Markdown
report and a JSON result into `reports`.

Each dump gets a fresh Claude Agent SDK session. The result has a `status` of
`success` or `failure`. The agent can inspect the assigned dump with a small set
of debugger commands. It has no shell or file-writing tools.

This is a local proof of concept for starting programmable Claude Code sessions
from TypeScript. It runs one dump at a time, with instructions in a Markdown
file, two debugger tools, two history tools, and a defined result schema.
Matching crashes share a Markdown triage with links to their individual reports.

## What runs where

The agent runs in a Linux Docker container. WinDbg and mcp-windbg run on Windows,
because the Windows debugger cannot run inside that Linux container.

```text
Windows: dumps folder --> Docker: TypeScript watcher --> Claude Agent SDK
                                                           |
Windows: WinDbg <--------- mcp-windbg over HTTP <-------------+
                                                           |
Windows: reports folder <-- Markdown and JSON <--------------+
```

The dump stays on your machine. The agent sends debugger text to Claude's model
service to interpret it. Use a sample dump first; debugger output can contain
application data.

## 1. Install the prerequisites

You need Windows, PowerShell, and these tools:

- **Git**, to clone the example.
- **Docker Desktop**, running Linux containers.
- **WinDbg** or the Windows SDK's **Debugging Tools for Windows**. mcp-windbg
  needs `cdb.exe` for application dumps and `kd.exe` for kernel dumps.
- **uv**, which provides the `uvx` command used to start mcp-windbg.
- A Claude token or Anthropic API key.

If WinDbg or uv is missing, install them in PowerShell:

```powershell
winget install 9PGJGD53TN86 --accept-source-agreements --accept-package-agreements
winget install astral-sh.uv
```

Open a new PowerShell window afterwards so it sees the updated command paths.
Check Docker and uv:

```powershell
docker version
uvx --version
```

`docker version` should show both a Client and a Server. If it only shows the
Client, start Docker Desktop.

You do not need Node.js or a separate Claude Code installation on the host to
run the container. The image installs the Agent SDK, which includes its Claude
Code runtime. The TypeScript compiler is used during the image build; the final
image runs the compiled JavaScript with Node.js.

## 2. Clone the demo

```powershell
git clone https://github.com/svnscha/mcp-windbg-claude-sdk-demo.git
cd mcp-windbg-claude-sdk-demo
```

Run the remaining Docker commands from this directory. Docker Compose uses it
to find `compose.yaml`, `.env`, `dumps`, and `reports`.

## 3. Add your credential to .env

Create `.env` from the example if it does not exist:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

Choose **one** authentication method:

- With a Claude subscription, run `claude setup-token` on a machine with Claude
  Code installed. Copy the token into `CLAUDE_CODE_OAUTH_TOKEN`.
- With an API key from Claude Console, put it in `ANTHROPIC_API_KEY` instead.

For the subscription option, install Claude Code if needed using Anthropic's
[recommended native PowerShell installer](https://code.claude.com/docs/en/setup#install-claude-code):

```powershell
irm https://claude.ai/install.ps1 | iex
```

Open a new PowerShell window in the demo folder, then verify and generate a token:

```powershell
claude --version
claude setup-token
```

Leave the other value empty. A subscription token uses your account's limits;
an API key uses API billing/credits. Store the token only in `.env`, not in a
Dockerfile, prompt, screenshot, or Git commit. `.gitignore` and `.dockerignore`
exclude it. Docker Compose supplies it when the container starts.

Also check this setting:

```dotenv
DUMP_HOST_DIR='C:\path\to\mcp-windbg-claude-sdk-demo\dumps'
```

It must point to this checkout's `dumps` folder on Windows. The single quotes
keep the backslashes intact. Run `(Resolve-Path .\dumps).Path` to get the value
for your clone.

There are two names for the same folder: `/data/dumps` inside Docker and the
Windows path above. The watcher reads the first; mcp-windbg opens the second.
They must refer to the same files.

## 4. Start mcp-windbg on Windows

In the first PowerShell window, run:

```powershell
.\scripts\start-mcp.ps1
```

Leave this window running. The script downloads the pinned mcp-windbg 1.5.1
package on first use, starts it at `http://127.0.0.1:8000/mcp/`, and configures
the Microsoft symbol server with a cache in `.work\symbols`.

The container reaches it through
`http://host.docker.internal:8000/mcp/`, already configured in `.env`.

> [!IMPORTANT]
> The MCP HTTP endpoint has no authentication and can control the Windows
> debugger. Keep it bound to `127.0.0.1`. Docker Desktop reached this loopback
> listener during the POC test; no LAN listener or firewall rule was needed.
> If your Docker setup cannot reach it, investigate that connection rather than
> exposing an unauthenticated debugger with `--host 0.0.0.0`.

For a nonstandard debugger installation, add `--cdb-path` or `--kd-path` to the
command in the script. Matching private PDB files can be placed beside a dump;
mcp-windbg adds that directory to its symbol search path.

## 5. Build the image

Open a second PowerShell window in the demo directory:

```powershell
docker compose build
```

The first build downloads Node.js and the SDK. Later builds reuse Docker's cache.
The image uses Debian slim, runs as the unprivileged `node` user, and contains
no WinDbg installation. Its root filesystem is read-only at runtime; temporary
session data goes into `/tmp`.

Before using a dump, check that your credential can start a session:

```powershell
docker compose run --rm triage node dist/hello.js
$LASTEXITCODE
```

Expect `Hello from a programmable Claude session.` and exit code `0`.
`hello.ts` is the complete small example to read first. It calls `query()` with
no tools, handles the final result, and cleans up a temporary workspace. It does
not need the debugger service. Fix authentication errors here before continuing.

## 6. Add a sample dump

To use the public example from mcp-windbg:

```powershell
Invoke-WebRequest `
  -Uri https://raw.githubusercontent.com/svnscha/mcp-windbg/v1.5.1/src/mcp_windbg/tests/dumps/DemoCrash1.exe.7088.dmp `
  -OutFile .\dumps\DemoCrash1.exe.7088.dmp.partial
Move-Item .\dumps\DemoCrash1.exe.7088.dmp.partial .\dumps\DemoCrash1.exe.7088.dmp
```

Skip this if the sample file is already present. For your own dump, use the same
pattern: copy it with a `.partial` suffix, then rename it to its final name when
the copy finishes. This prevents a paused copy from looking like a completed file.

The watcher accepts `.dmp`, `.mdmp`, and `.hdmp`, including uppercase extensions,
in the top level of `dumps`. It waits until size and modification time have stayed
unchanged for ten seconds. Subdirectories and `.partial` files are ignored.

## 7. Check the debugger connection without spending model tokens

```powershell
docker compose run --rm triage node dist/check-mcp.js DemoCrash1.exe.7088.dmp
```

This opens the real dump, runs `kv` to inspect the stack, closes the debugger,
and saves raw output to `reports\mcp-check.txt`. It makes no Claude request.
For a kernel dump, append `--kernel`.

If this fails, fix the debugger connection or dump path before testing the agent.

## 8. Run one batch

```powershell
docker compose run --rm triage node dist/main.js --once
```

It waits for stable files, processes all pending dumps, and exits. Inspect the
process exit code in PowerShell:

```powershell
$LASTEXITCODE
```

- `0`: the eligible dumps completed successfully, or there were no dumps.
- `1`: at least one current dump has a failure result, or startup failed.

A previous failure for a file still in `dumps` also causes exit code 1. The
existing report is reused; it is not sent to Claude again.

## 9. Keep watching for new dumps

```powershell
docker compose up
```

Drop another file into `dumps` and wait. Press **Ctrl+C** to stop. Allow cleanup
to finish; the runner closes an open debugger even when the agent is cancelled.
A forced kill or host crash can still leave a remote debugger session behind.

Run only one watcher against a given dumps/reports pair. This POC has no shared
queue or lock for multiple containers.

## Read the results

Each dump produces a pair with the same name:

```text
reports/DemoCrash1.exe.7088.dmp-<fingerprint>.md
reports/DemoCrash1.exe.7088.dmp-<fingerprint>.json
```

The Markdown contains findings, debugger evidence, limitations, next steps, and
the calls recorded by the runner. JSON contains the same analysis with timestamps,
the file fingerprint, and the SDK's estimated model cost.

- **success** means the dump opened and the agent completed triage with evidence.
  It does not mean the suspected root cause is proven or that a fix exists.
- **failure** means analysis, validation, or cleanup failed. The report explains
  what happened. The watcher can continue to other files.

The runner requires a validated structured response. A model claiming success
without opening the dump and returning evidence is converted to failure. SDK
errors, cancellation, and invalid responses also become failure reports.

The fingerprint uses filename, size, and modification time. Existing report
pairs are skipped after a restart, including failures. To retry, remove that
dump's `.md` and `.json` files from `reports`, then run again. Changing only a
prompt does not automatically rerun old dumps. This fingerprint is not a content
hash; replacing bytes while preserving size and timestamp will not be detected.

Markdown is written first and JSON last, using temporary files and renames. A
half-written report pair is not treated as finished on the next run. If a dump
changes during triage, its result is discarded and the watcher waits again.

## Change the workflow

### Remember similar crashes

Every dump keeps its own report. Successful investigations also create or join
a shared Markdown file in `reports/triages/<id>.md`. That file holds the initial
findings and evidence, followed by an occurrence list linking each dump report.

Claude calls `list_triages` for IDs and short summaries, then `read_triage` for
plausible matches. Its structured result contains `triage_match`: either `null`
for a new triage, or an existing ID and the evidence connecting the crashes.
The runner requires a history check before accepting success and requires the
agent to read any triage it selects. IDs are validated; the tools cannot read
arbitrary paths. Claude has no history-writing tool.

The instructions ask Claude to compare the fault location, relevant stack,
failure mechanism, and compatible build information. The same exception code
alone does not establish the same bug. Uncertain matches stay separate. These
are model judgments, so review the recorded match reason and debugger evidence.

The program saves the individual report first, then appends the occurrence.
If a history write fails, the batch exits with code 1. Restarting finishes the
history write from the saved report without another agent call. Each occurrence
has a stable marker, so retries do not append it twice. Failed investigations
never enter shared triages. Keep one watcher for the folder pair.

To try matching after the sample's first successful run, copy it under another
name and run again:

```powershell
Copy-Item .\dumps\DemoCrash1.exe.7088.dmp .\dumps\DemoCrash1-repeat.dmp.partial
Move-Item .\dumps\DemoCrash1-repeat.dmp.partial .\dumps\DemoCrash1-repeat.dmp
docker compose run --rm triage node dist/main.js --once
```

Inspect the new report's shared-triage link and matching reason. This deliberately
uses the same sample bytes to demonstrate the flow, not two independent crashes.
Generated results are ignored by Git, so a fresh clone starts empty.

Keep shared triage files that other reports reference. The Markdown files are
the shared state; every Claude session still starts fresh.

### Instructions, tools, and output

Edit `workflows/triage.md` to change the analysis instructions. Compose mounts
that folder read-only, so the next session sees the change without rebuilding.

The tool list is intentionally small:

| Agent tool | What it does |
| --- | --- |
| `open_dump` | Opens only the file assigned by the watcher, using CDB or KD according to the dump header |
| `run_command` | Runs one of the inspection commands listed in `COMMANDS` in `windbg.ts` |
| `list_triages` | Lists IDs and short summaries of the Markdown triages in `reports/triages` |
| `read_triage` | Reads one of those triages so Claude can compare its debugger evidence |

The debugger tools are thin wrappers around your real mcp-windbg service. They own
the path and session ID. The agent cannot choose another file, attach to a live
process, run `.shell`, or pick an arbitrary debugger command. The runner closes
the session in a `finally` block. The history tools read local Markdown files
through `history.ts`; they do not call the Windows service.

To enable another command, review and edit `COMMANDS`, then rebuild the image.
To change the output fields, edit `AnalysisSchema` in `result.ts` and the Markdown
renderer beside it. The application writes reports; Claude needs no file tools.

`agent.ts` sets a twelve-turn limit, a five-minute agent timeout, and a $2
estimated-cost budget per dump. The SDK's cost estimate is not an exact billing
statement or a guaranteed hard spending cap. Cleanup may continue after the
agent timeout while an in-flight debugger operation finishes.

Each session gets a new temporary workspace/config directory, no persisted
session, no automatic memory, and `settingSources: []`. Only the explicitly
registered MCP tools are connected. Personal Claude instructions and login files
are not mounted. Organization-managed policies can still apply to your credential.

## Optional exercises

Run these from the demo folder after the sample has succeeded, with mcp-windbg
still running. Each new input can start another Claude session.

### Observe a controlled failure

Create a text file pretending to be a dump:

```powershell
Set-Content -LiteralPath .\dumps\not-a-dump.dmp.partial -Value 'This is not a Windows crash dump.'
Move-Item .\dumps\not-a-dump.dmp.partial .\dumps\not-a-dump.dmp
docker compose run --rm triage node dist/main.js --once
$LASTEXITCODE
```

Expect exit code `1` and a failure report, with no shared triage:

```powershell
$failedFile = Get-ChildItem .\reports -Filter 'not-a-dump.dmp-*.json' | Select-Object -First 1
$failed = Get-Content -LiteralPath $failedFile.FullName -Raw | ConvertFrom-Json
$failed | Select-Object status, summary, triage_id
```

Repeating the batch reuses the report and still exits `1` while that failed
input remains in `dumps`. Rename the input to exclude it from later batches:

```powershell
Rename-Item -LiteralPath .\dumps\not-a-dump.dmp -NewName not-a-dump.txt
docker compose run --rm triage node dist/main.js --once
$LASTEXITCODE
```

Expect `0` if the remaining dumps succeeded. The failure report stays available.

### See a prompt change take effect

Back up the instructions, add a visible marker, and use a fresh filename:

```powershell
Copy-Item .\workflows\triage.md .\workflows\triage.before-lesson.txt
Add-Content -LiteralPath .\workflows\triage.md -Value "`nFor this learning exercise, start the summary with the exact text: TRIAGE LAB:"
Copy-Item .\dumps\DemoCrash1.exe.7088.dmp .\dumps\prompt-experiment.dmp.partial
Move-Item .\dumps\prompt-experiment.dmp.partial .\dumps\prompt-experiment.dmp
docker compose run --rm triage node dist/main.js --once
$LASTEXITCODE
```

Expect exit code `0`. Read the new summary:

```powershell
$experimentFile = Get-ChildItem .\reports -Filter 'prompt-experiment.dmp-*.json' | Select-Object -First 1
$experiment = Get-Content -LiteralPath $experimentFile.FullName -Raw | ConvertFrom-Json
$experiment.summary
```

It should begin with `TRIAGE LAB:`. No rebuild was needed: Compose mounts
`workflows`, and every session reads its instructions again. Existing reports
stay skipped even when the prompt changes.

Restore the original instructions:

```powershell
Copy-Item .\workflows\triage.before-lesson.txt .\workflows\triage.md -Force
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| "Set exactly one..." | Fill one credential in `.env` and leave the other empty |
| Connection refused / fetch failed | Keep `start-mcp.ps1` running; check port 8000 and Docker Desktop |
| File not found in debugger output | Check `DUMP_HOST_DIR`; it is a Windows path, not `/data/dumps` |
| Missing function names | Supply matching private PDB files; public symbols do not cover your application |
| No new report | Wait ten seconds; check extension and existing report pairs |
| Agent failure with no debugger call | Check token expiry, account limits, model access, or organization policies |
| Port 8000 is already used | Stop the previous demo server, or use `start-mcp.ps1 -Port 8001` and update `.env` |

## Develop and test locally

Node.js 24 or newer is needed only if you want to work on the TypeScript outside
Docker:

```powershell
npm ci
npm test
```

Tests cover partial copies, changes during analysis, restart deduplication,
failure reports, kernel selection, and cancellation. They use fake analysis
results and make no model calls. The separate `check:mcp` command exercises the
real MCP service and debugger.

For local execution, point `MCP_WINDBG_URL` at `http://127.0.0.1:8000/mcp/` in the
process environment. `npm start` loads `.env` if it exists; existing environment
variables take precedence. Build first with `npm run build`.

## References

- [Claude Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)
- [SDK configuration isolation](https://code.claude.com/docs/en/agent-sdk/claude-code-features)
- [Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)
- [Structured output](https://code.claude.com/docs/en/agent-sdk/structured-outputs)
- [mcp-windbg HTTP service](https://svnscha.github.io/mcp-windbg/scenarios/http-service/)
