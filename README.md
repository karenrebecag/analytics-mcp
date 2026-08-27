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

## Remote auth: the sign-in page contract

This server implements OAuth 2.1 (dynamic registration, PKCE with S256 pinned,
single-use codes, refresh rotation with reuse detection, revocation) — but it
**does not authenticate anyone itself**. `/authorize` validates the request and
redirects to `FRONTEND_URL`, a page you host, which must:

1. authenticate the user however you like (Clerk, your own login, anything);
2. mint an authorization code as a JWT signed with `MCP_SIGNING_SECRET`,
   carrying `sub`, optionally `email`, and echoing back `client_id`,
   `redirect_uri`, `code_challenge`, `code_challenge_method`, plus a unique
   `jti`, with issuer `<MCP_ISSUER>-oauth` and audience `<MCP_ISSUER>`;
3. redirect back to `redirect_uri` with that code and the original `state`.

Everything after that — verifying PKCE, binding the code to its client,
enforcing single use, issuing and rotating tokens — happens here. Keeping the
login page outside this repo is what lets the same code serve any identity
provider without a fork.

Auth state (single-use codes, revocation) needs Upstash Redis in production;
without it every exchange **fails closed** rather than proceeding unverified.

## Design notes (short version)

- No org-specific anything in this repo. Your sites, properties and tokens are
  configuration (`SITES_CONFIG` + env vars) — see `.env.example` and
  `sites.example.json`.
- "Remote" here means *your* deployment with *your* credentials, not
  multi-tenant SaaS.
- Every source adapter is typed against real API responses captured by
  `pnpm probe` — never against guessed shapes.

License: MIT.
