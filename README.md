# Agent SDK starter

A small TypeScript starting point for programmable Claude sessions.
`agent.ts` exports `runAgent(prompt, options)` and runs a greeting when launched directly.
It starts with no tools or personal Claude settings. Pass SDK options to add your own tools and task.

## Run

Use Node.js 24 or Docker. Clone the repo, copy `.env.example` to `.env`, and
fill **one** credential: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.

For a subscription token, run `claude setup-token`. If Claude Code is missing,
use the [official PowerShell installer](https://code.claude.com/docs/en/setup#install-claude-code),
then open a new terminal:

```powershell
irm https://claude.ai/install.ps1 | iex
```

Locally:

```sh
npm ci
npm start
```

Or in Docker:

```sh
docker build -t agent-sdk-starter .
docker run --rm --env-file .env agent-sdk-starter
```

Expect `Hello from the Agent SDK.`. This makes a model request using your
subscription allowance or API credits. Keep `.env` private.

To build a workflow, import `runAgent` in your own TypeScript file and supply
the prompt, MCP tools, and optional structured-output schema. Node 24 runs
TypeScript directly; there's no compiler or build step.

An optional third argument receives the SDK's final result, including
`total_cost_usd`, before success or error handling. This is an estimated USD cost,
not a billing amount. If the session ends without a result, the callback isn't called.
