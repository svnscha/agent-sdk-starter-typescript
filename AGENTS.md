# Project guidance

This is a small TypeScript demo of Claude Agent SDK crash triage with mcp-windbg.
Read README.md for setup and usage. Keep the example focused on instructions,
four explicit tools, structured results, and Markdown history.

- Use Node.js 24 and npm. Run `npm test` after TypeScript changes.
- Build the container with `docker compose build` after Docker changes.
- Tests use fake results; live Claude runs consume account usage.
- Keep credentials, dumps, generated reports, and local verification notes out
  of Git and Docker builds.
- The main branch is `main`. Use `feat/` or `fix/` for subsequent work.
