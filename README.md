# analytics-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that puts
**GA4, Cloudflare Web Analytics, Vercel Analytics and Google Search Console**
behind one normalized tool surface — and, more importantly, teaches the model
what the numbers *mean*.

Ask "how did the site do last week?" and every tracker you run answers at once,
with the gaps between them explained instead of hidden.

- **Remote**: StreamableHTTP + OAuth 2.1, deployable to Vercel — usable from
  Claude web and any remote MCP client.
- **Local**: the same server over stdio for Claude Code, Cursor, Claude Desktop.
- **Explains itself**: every metric carries a plain-language meaning, and the
  server knows which discrepancies between trackers are structural.

---

## Why another analytics MCP

There are already good GA4 MCP servers. They share three limits: single source,
stdio only, and numbers without meaning. This one is built around the other
three answers.

**One question, every tracker.** GA4 and Cloudflare will never agree on
pageviews. Most tools hide that. `query` fans out to every source bound to a
site, reports each answer separately, and notes where they diverge — because
the divergence is information, not an error.

**The gaps are explained, not averaged.** The server codifies *why* two
trackers differ: one counts in the browser after a cookie banner, another
counts raw requests at the network edge including bots. `explain_discrepancy`
gives a deterministic verdict on whether a gap is normal, and says plainly when
it has no criterion rather than inventing a number.

**Written for someone who has never opened an analytics dashboard.** Each
metric ships with a `businessMeaning` in plain words — *"How many times a page
was opened. One person who reads three pages counts three times."* — and the
bundled prompts instruct the model to lead with the business answer, never the
metric name. The person reading the answer should not need to know what GA4 is.

---

## Architecture

```
                    ┌──────────────────────────────┐
   Claude web  ───► │  api/mcp.ts   (serverless)   │ ── OAuth 2.1 + PKCE
                    ├──────────────────────────────┤
   Claude Code ───► │  src/index.ts (stdio)        │ ── local, no auth
                    ├──────────────────────────────┤
   private host ──► │  src/serve.ts (long-lived)   │ ── static bearer
                    └───────────────┬──────────────┘
                                    │  all three call
                                    ▼
                          createServer()          ← host-agnostic
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              tools + prompts   semantics/     sources/registry
                + resources     knowledge.ts         │
                                (the criterion)      │
                                         ┌───────────┼───────────┐
                                         ▼     ▼     ▼           ▼
                                       GA4   CF    Vercel      GSC
```

Two rules hold this together, and the test suite enforces both:

1. `createServer()` imports nothing from Vercel, HTTP or stdio. It cannot tell
   where it runs, so there is no environment branch to rot.
2. Environment switching lives in exactly two places — the entry points and
   `src/sources/registry.ts`. An environment `if` inside a tool is a bug.

### Honest scope

**"Remote" means your deployment with your credentials, not a hosted service.**
There is no multi-tenant mode: you deploy it, you set your own tokens, you are
the only tenant. That is a deliberate limit, not a missing feature — analytics
credentials read your whole audience, and pooling them behind someone else's
service is the wrong trade.

---

## Tools

| Tool | What it does |
| --- | --- |
| `list_sites` | Configured sites and which trackers cover each |
| `list_sources` | Which adapters are configured (presence only, never values) |
| `get_schema` | Metrics and dimensions available per source |
| `query` | **Primary.** Normalized query fanned out across every bound source |
| `query_raw` | Escape hatch: a native payload to one source |
| `explain_discrepancy` | Is this gap between two trackers normal? Deterministic |
| `validate_query` | Dry-run: unsupported metrics, truncated ranges, bad comparisons |

Every tool is read-only. There are no write tools and none are planned.

**Canonical metrics**: `pageviews`, `sessions`, `visitors` (site-side) and
`clicks`, `impressions`, `ctr`, `position` (Google Search). Each maps to its
native name per source; a source that cannot answer one returns a warning in
its slot rather than failing the whole query.

### Resources and prompts

- `analytics://metrics` — what every metric means, how each source counts it,
  and how far two sources normally differ.
- `analytics://metrics/{siteId}` — the same, plus expectations measured for one
  site.
- `interpret-query` — how to explain results to a non-technical reader.
- `site-report` — end-to-end recipe: query every tracker, reconcile the
  differences, write *what happened / what changed / what deserves attention /
  what to check next*.

---

## Setup

Requires **Node 20+** and **pnpm**.

```bash
git clone https://github.com/karenrebecag/analytics-mcp.git
cd analytics-mcp
pnpm install
pnpm build
```

### 1. Describe your sites

`SITES_CONFIG` is a JSON array mapping a friendly id to per-source
identifiers. See `sites.example.json`:

```json
[
  {
    "id": "marketing-site",
    "name": "Marketing website",
    "sources": {
      "ga4": { "propertyId": "123456789" },
      "cloudflare": { "zoneId": "0123…", "host": "www.example.com" },
      "gsc": { "siteUrl": "sc-domain:example.com" }
    }
  }
]
```

A site needs only the sources you actually run. Optionally add an
`expectations` block to record the normal gap between two trackers *for that
site*, which overrides the generic criterion.

### 2. Credentials

Copy `.env.example` to `.env` and fill in what applies. Every source is
optional — the server runs with one, or all four.

| Source | Variable | How to get it |
| --- | --- | --- |
| GA4 | `GA4_SERVICE_ACCOUNT_JSON` | Service account key (one line). Add its email as a **Viewer** on each GA4 property. |
| Cloudflare | `CLOUDFLARE_API_TOKEN` | Token with *Account Analytics: Read*. Add `CLOUDFLARE_ACCOUNT_ID` to read Web Analytics (RUM); without it the adapter reads zone HTTP analytics instead. |
| Vercel | `VERCEL_API_TOKEN` | Account settings → Tokens. |
| Search Console | `GSC_SERVICE_ACCOUNT_JSON` | Service account added as a user in Search Console. Leave empty to reuse the GA4 key. |

> **Cloudflare's two modes matter.** With an account id it reads the Web
> Analytics beacon (browser-side, undercounts like GA4). Without one it reads
> zone HTTP requests (edge-side, includes bots and assets, routinely several
> times higher). The server knows the difference and adjusts what it calls a
> normal discrepancy.

### 3. Verify against your own data

```bash
pnpm probe
```

Calls the cheapest real read on every configured source and writes the raw
responses to `scratch/` (gitignored). If a source is misconfigured you find out
here rather than mid-conversation. Nothing it does writes to your accounts.

---

## Run it

### Local (Claude Code, Cursor, Claude Desktop)

```json
{
  "mcpServers": {
    "analytics": {
      "command": "node",
      "args": ["/absolute/path/to/analytics-mcp/dist/index.js"],
      "env": { "SITES_CONFIG": "[…]", "GA4_SERVICE_ACCOUNT_JSON": "{…}" }
    }
  }
}
```

Use an absolute path. Check it without a client:

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node dist/index.js
```

### Remote (Claude web) — deploy to Vercel

Deploy the repo, then set the environment variables from `.env.example` on the
project. Beyond your source credentials you need:

| Variable | Why |
| --- | --- |
| `MCP_SIGNING_SECRET` | Signs every token this server issues. Rotating it invalidates all of them. |
| `FRONTEND_URL` | Your sign-in page — see the contract below. |
| `UPSTASH_REDIS_REST_URL` + `_TOKEN` | Auth state. **Required in production**: without it every token exchange fails closed. Vercel's Upstash integration injects `KV_REST_API_*`, which is also accepted. |
| `ALLOWED_EMAIL_DOMAIN` | Optional. Restrict access to one email domain; empty means no restriction. |
| `CLERK_JWT_KEY` | Optional. Also accept Clerk session tokens as bearers. This is the **public** PEM (Clerk → API keys → Show JWT public key), so the server never holds a credential that can mint or revoke sessions. `CLERK_SECRET_KEY` works too, but grants far more than verification needs. |

Then add `https://your-deployment/mcp` as a custom connector in Claude. The
OAuth flow starts on its own — the `401` carries the `WWW-Authenticate` header
that triggers it.

#### The sign-in page contract

This server implements OAuth 2.1 — dynamic client registration, PKCE with S256
pinned, single-use authorization codes, refresh rotation with reuse detection,
and revocation — but it **does not authenticate anyone itself**. `/authorize`
validates the request and redirects to `FRONTEND_URL`, a page you host, which
must:

1. authenticate the user however you like — Clerk, your own login, anything;
2. mint an authorization code as a JWT signed with `MCP_SIGNING_SECRET`,
   carrying `sub`, optionally `email`, and echoing back `client_id`,
   `redirect_uri`, `code_challenge` and `code_challenge_method`, plus a unique
   `jti`. Issuer `<MCP_ISSUER>-oauth`, audience `<MCP_ISSUER>`
   (default `analytics-mcp`);
3. redirect back to `redirect_uri` with that code and the original `state`.

Everything after that — verifying PKCE, binding the code to its client,
enforcing single use, issuing and rotating tokens — happens here. Keeping the
login page outside this repo is what lets the same code serve any identity
provider without a fork.

### Persistent host (optional)

`pnpm serve` runs a long-lived HTTP server instead of serverless functions.
It is not the default path; it exists so that reaching a source which needs a
machine that stays up is a new adapter plus this entry, not a rewrite.

Auth is a static `SERVE_BEARER_TOKEN`, meant to sit behind a reverse proxy.
Without a token it **refuses to bind anything but loopback** — an
unauthenticated MCP server reachable from the network is a data leak, not a
convenience.

---

## Notes that will save you time

**Quotas and cache.** GA4 charges tokens per property per day. `query` caches
each successful per-source result for 5 minutes, keyed by a hash of the
normalized request (`QUERY_CACHE_TTL_S` to change it). On serverless, set
Upstash — an in-process cache dies with the isolate and buys you nothing.

**Slow sources degrade, they do not fail.** Each source gets its own timeout
(`QUERY_SOURCE_TIMEOUT_MS`, default 10s). A source that times out becomes an
entry in `errors`; the rest of the answer still arrives. A missing source means
*no data from that source* — never zero traffic.

**Row caps truncate silently upstream.** Cloudflare returns at most 40 daily
rows, Search Console 1000, GA4 10000. `validate_query` warns before you read
numbers that quietly left data out.

**Adapters are typed against real captures**, never against documentation.
`pnpm probe` first, then the adapter. Docs drift; captured responses do not.

---

## Development

```bash
pnpm verify   # typecheck + lint + format + unit tests + build gates
```

`pnpm gates` builds the project and runs `tests/gates/` against the compiled
artifact: a small security suite (secret hygiene, PKCE pinning, redirect_uri
allowlist, fail-closed auth state, no logs on the MCP channel) and a
performance suite (cold start, parallel fan-out, timeout isolation, cache
hits). They are budgets and invariants, not benchmarks. Do not weaken a gate to
make it pass — a red gate means the implementation is wrong.

`SPEC.md` holds the per-file implementation contracts and the full gate list.

## License

MIT. Not affiliated with Google, Cloudflare or Vercel.
