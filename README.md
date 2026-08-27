# analytics-mcp

Unified web-analytics [MCP](https://modelcontextprotocol.io) server: **GA4,
Cloudflare Web Analytics, Vercel Analytics and Google Search Console** behind
one normalized tool surface. One question — "how did the site do last week?" —
answered across every tracker you run, with the discrepancies between them
reported instead of hidden.

- **Remote**: StreamableHTTP + OAuth 2.1, deployable to Vercel in one click —
  usable from Claude web.
- **Local**: the same server over stdio for Claude Code / Cursor / Desktop.

> **Status: spec-driven build in progress.** `SPEC.md` holds the per-file
> implementation contracts and phase gates. Not usable yet.

## Design notes (short version)

- No org-specific anything in this repo. Your sites, properties and tokens are
  configuration (`SITES_CONFIG` + env vars) — see `.env.example` and
  `sites.example.json`.
- "Remote" here means *your* deployment with *your* credentials, not
  multi-tenant SaaS.
- Every source adapter is typed against real API responses captured by
  `pnpm probe` — never against guessed shapes.

License: MIT.
