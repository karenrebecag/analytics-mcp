# SPEC — analytics-mcp

Open-source MCP server unifying **GA4, Cloudflare Web Analytics, Vercel
Analytics and Google Search Console** under one normalized tool surface.
Remote via StreamableHTTP + OAuth 2.1 (Claude web), local via stdio (Claude
Code). Serverless-first on Vercel; adapters hit each source's HTTP API
directly with credentials from env.

This document is the **implementation contract**. Agents implement one phase
at a time, exactly to the file contracts below. `pnpm verify` (unit + gates)
is the tripwire; a phase is not done until it is green. Review + commit + push
happen once per phase, after human-side code review.

---

## 1. Structural decisions (do not relitigate)

**Org decoupling.** No organization exists in code, tests, fixtures or docs.
Business use = configuration: `SITES_CONFIG` + env vars in a private
deployment. Only `sites.example.json` with fictitious ids is committed.

**The seam.** `createServer()` is host-agnostic. Environment switching exists
in exactly two places: entry points (`api/mcp.ts`, `src/index.ts`,
`src/serve.ts`) and `src/sources/registry.ts`. An environment `if` inside a
tool is a bug.

**Probe before typing.** No adapter is typed against a guessed response
shape — even for documented APIs. `pnpm probe` captures real responses to
`scratch/` (gitignored); adapters and fixtures derive from captures.

**Dependencies are frozen.** Runtime: `@modelcontextprotocol/sdk`, `zod`;
F3 adds `jose` and `@clerk/backend`. Nothing else without a spec change.
GA4/GSC service-account JWTs are signed with `node:crypto` (RS256), not a
Google SDK.

---

## 2. File contracts

Each entry states what the file MUST do and what its acceptance criteria are.
Copying proven patterns from PowerAutomate_mcp / SalesforceATFX_mcp is
expected where noted. One tool per file; every handler routes through
`runTool`; all tools `readOnlyHint: true`.

### Phase F0 — contract, config, cache, config-tools, stdio entry

```
src/sources/types.ts
  # The seam. Pure types + constants, no runtime imports, no node: imports.
  # - SOURCE_IDS = ['ga4', 'cloudflare', 'vercel', 'gsc'] as const; SourceId union.
  # - SourceAuthKind = 'http-api' | 'mcp-subprocess'   (subprocess: interface only in v1)
  # - DateRange { start, end }: ISO yyyy-mm-dd strings.
  # - Granularity = 'day' | 'week' | 'month' | 'total'.
  # - QueryRequest { siteId, range, granularity, metrics: string[], dimensions?: string[] }
  # - QueryResult  { source: SourceId, timezone: string (IANA), rows: Array<Record<string,
  #   string | number>>, warnings?: string[] }
  # - SchemaEntry  { name, kind: 'metric' | 'dimension', description }
  # - SiteSourceBinding types per source (ga4.propertyId; cloudflare.zoneId + optional host;
  #   vercel.projectId + optional teamId; gsc.siteUrl).
  # - AnalyticsSource { id, authKind, isConfigured(env): boolean  # env presence check ONLY,
  #   never a network call; schema(); query(req, binding); queryRaw(body, binding) }.
  CRITERIA: tsc strict clean; zero imports.

src/config/sites.ts
  # Parse + validate SITES_CONFIG (JSON array in env) with zod .strict() schemas.
  # - loadSites(env = process.env): Site[].  Missing var -> []. 
  # - Invalid JSON -> throw WITHOUT echoing the raw content (env tooling places it next
  #   to secrets); message says the var name and "not valid JSON" only.
  # - Shape errors -> throw listing zod issue PATHS only (e.g. "0.sources.ga4.propertyId"),
  #   never values.
  # - getSite(sites, id): Site — not-found error lists available ids (ids are not secret).
  CRITERIA: unit tests for all 4 branches; a leak assertion proves error messages
  exclude config values.

src/core/tool-result.ts
  # jsonResult / errorResult / runTool. Copy the PowerAutomate_mcp implementation
  # verbatim (same contract: thrown errors become isError results, never crash transport).
  CRITERIA: covered indirectly by tool tests.

src/core/cache/types.ts
  # CacheStore { get(key): Promise<string | null>; set(key, value, ttlSec): Promise<void> }.
src/core/cache/memory.ts
  # createMemoryCache(): Map + expiresAt; expired entries deleted on read.
src/core/cache/upstash.ts
  # createUpstashCache({ url, token, fetchImpl? }): Upstash REST protocol — POST url,
  # JSON body ["GET", key] / ["SET", key, value, "EX", ttl], Authorization: Bearer.
  # fetchImpl injectable for tests. Token never logged, never in error messages.
src/core/cache/index.ts
  # createCacheStore(env): upstash when BOTH env vars set, else memory.
  CRITERIA: memory TTL via fake timers; upstash asserts request shape + bearer header
  via injected fetch; factory selection test; error-path test proves token absent from
  thrown messages.

src/sources/registry.ts
  # The ONLY place adapters are instantiated and listed (besides entries, the only
  # file allowed to know about environment kind).
  # - allSources(): AnalyticsSource[]  — F0 returns []; F1 adds the four adapters.
  # - getSource(id): error message lists valid ids.
  # - setSourcesForTests(list | null)  — test injection, same pattern as the reference
  #   setAuthStateStoreForTests.
  CRITERIA: getSource error test; injection test.

src/tools/list-sites.ts
  # listSitesSchema = z.object({}). Returns { count, sites: [{ id, name,
  # sources: string[] (keys of bindings) }] }. No binding values in output
  # (property/zone ids stay server-side; they are config, not payload).
src/tools/list-sources.ts
  # listSourcesSchema = z.object({}). Returns per registered adapter:
  # { id, authKind, configured: boolean }. NEVER credential values.
src/tools/index.ts
  # Barrel, PowerAutomate_mcp style.
  CRITERIA: handler tests with fixture SITES_CONFIG + injected fake source.

src/server.ts
  # createServer(): McpServer 'analytics-mcp' v0.1.0, registers tools with
  # readOnlyHint: true + openWorldHint: true, instructions from instructions.ts.
  # MUST NOT import transports, node:http, or anything Vercel.
src/instructions.ts
  # Server instructions string. F0 placeholder naming the two tools; final text in F2.
src/index.ts
  # stdio entry, PowerAutomate_mcp style: connect StdioServerTransport; stdout is
  # the MCP channel — all logs to stderr; lazy credential checks (server registers
  # cleanly with zero env).
  CRITERIA: gates spawn it (see §3).

tests/  (F0 unit files)
  # config.test.ts, cache.test.ts, tools.test.ts, registry.test.ts — the criteria above.
  # tests/gates/helpers.ts — spawnBuiltServer(env) + JSON-RPC line client used by gates:
  #   sends initialize / initialized / arbitrary request against dist/index.js, collects
  #   stdout+stderr separately, kills on done.
```

### Phase F1 — probe + adapters (needs real credentials in env)

```
scripts/probe.ts
  # Phase-0-style recon (PowerAutomate_mcp heritage). For each source with creds
  # present: make the cheapest real read (GA4 metadata; CF zone viewer query;
  # Vercel project list; GSC sites list), write raw response to
  # scratch/<source>-<endpoint>.json via a single writeCapture(name, data) helper.
  # - writeCapture resolves ONLY under scratch/, rejects traversal, creates dir.
  # - Prints an ok/fail table; exit 1 if any CONFIGURED source fails.
  # - Never writes outside scratch/. Never prints tokens (print env var NAMES).
src/sources/ga4.ts
  # AnalyticsSource over GA4 Data API v1beta. Auth: service-account JWT RS256 via
  # node:crypto (createSign), token cached in-process, refreshed 60s early
  # (token.ts pattern from PowerAutomate_mcp). runReport for query; Metadata API
  # for schema(). Types come from scratch/ captures.
src/sources/cloudflare.ts
  # GraphQL API (api.cloudflare.com/client/v4/graphql), Bearer CLOUDFLARE_API_TOKEN.
  # Zone http requests + RUM/Web-Vitals datasets; optional host filter from binding.
src/sources/vercel.ts
  # Vercel REST, Bearer VERCEL_API_TOKEN, optional teamId query param.
src/sources/gsc.ts
  # Search Console searchanalytics.query. Reuses GA4 key when GSC_SERVICE_ACCOUNT_JSON
  # empty; scope https://www.googleapis.com/auth/webmasters.readonly. Shares the JWT
  # signer with ga4.ts — extract src/sources/google-auth.ts if it keeps both files
  # under ~300 lines.
  ALL ADAPTERS:
  # - isConfigured = env presence only.
  # - Upstream error -> Error with status + body truncated to 300 chars; NEVER echo
  #   Authorization headers or tokens.
  # - query() accepts a timeoutMs (AbortSignal.timeout); default from caller.
  # - registry.ts now returns all four.
  CRITERIA: unit tests use fixtures derived from scratch/ captures (fictitious ids
  substituted before committing — org decoupling rule); injected fetch everywhere.
```

### Phase F2 — normalization + query tools

```
src/core/normalize.ts
  # Pure functions, table-driven.
  # - CANONICAL_METRICS with per-source coverage map. Starting set:
  #   pageviews, sessions, visitors, clicks, impressions, ctr, position.
  #   (native names per source come from F1 captures, e.g. ga4:screenPageViews.)
  # - toNative(source, canonical) / toCanonical(source, native).
  # - Unknown metric for a source -> that source returns a warning in its slot,
  #   NOT an error, and other sources still answer.
  # - Timezones: each adapter DECLARES its tz; normalize never converts — report,
  #   don't guess.
  # - discrepancyNotes(results): same canonical metric from >1 source -> % delta note.
src/tools/get-schema.ts
  # { source? } -> SchemaEntry[] per source (all configured sources when omitted).
  # GA4 from Metadata API (cached, TTL 1h); others curated static from captures.
src/tools/query.ts
  # The primary tool. Input schema: { site, range { start, end }, granularity,
  # metrics (min 1), dimensions?, sources? (subset of SOURCE_IDS) }.
  # - Resolves site binding; targets = sources param ∩ configured ∩ bound for site.
  # - Fan-out with Promise.allSettled — PARALLEL, per-source timeoutMs
  #   (default 10000, env QUERY_SOURCE_TIMEOUT_MS). A failed/slow source yields
  #   { source, error } in its slot; the response as a whole succeeds.
  # - Cache wrapper: key = sha256 of normalized request; TTL 300s
  #   (env QUERY_CACHE_TTL_S); caches only fully-successful per-source slots.
  # - Output: { site, range, results: QueryResult[], errors?: [...], notes?:
  #   discrepancy notes }.
src/tools/query-raw.ts
  # { source (enum of SOURCE_IDS — allowlist enforced by schema), site, body }.
  # Passes body verbatim to adapter.queryRaw. No cache. Response body truncated
  # to a sane max (32KB) with a truncation note.
src/instructions.ts
  # Final text: start with list_sites; query is primary; query_raw is the escape
  # hatch; discrepancies between independent trackers are expected and reported,
  # not errors.
  CRITERIA: fixture tests per tool; normalize table tests; §3 F2 gates.
```

### Phase F2.5 — semantic layer (after F2)

The server codifies business *criterion* — never reasoning. It knows facts
the client LLM cannot know (how each tracker counts, what discrepancy is
structural); it never decides what matters. No LLM inside the server, ever.

**Audience principle:** the end reader of every answer built on this server
is a person with ZERO analytics skills making business decisions. The
semantic layer's job is to let the client LLM translate numbers into plain
business language with honest caveats — so this audience is encoded in the
prompts and metric definitions, not assumed.

```
src/semantics/knowledge.ts
  # The codified criterion. Pure data module, no I/O, no env reads.
  # - METRIC_SEMANTICS: per canonical metric x source -> { native, definition,
  #   businessMeaning (plain language, no jargon: what this number tells a
  #   decision-maker), caveats }  (e.g. cloudflare counts at the edge and includes some bots;
  #   ga4 counts post-JS and loses adblocked sessions). Native names and limits
  #   come from F1/F2 captures, not memory.
  # - EXPECTED_DISCREPANCY: per (metric, sourceA, sourceB) -> { maxRatio, reason }.
  #   GENERIC source-pair knowledge only. Per-site expectations are runtime
  #   config: optional `expectations` block in SITES_CONFIG (sites.ts schema
  #   extends; sites.example.json shows fictitious values). Org decoupling
  #   forbids any site-specific number in this module.
  # - VALIDATION_RULES: request-shape criteria verified against captures
  #   (e.g. per-source max range at day granularity, metric coverage per source).
src/resources/metrics.ts
  # MCP resource analytics://metrics (and analytics://metrics/<siteId> when the
  # site has an `expectations` block): METRIC_SEMANTICS + EXPECTED_DISCREPANCY
  # rendered as JSON. Passive context so the client can reason about what it is
  # comparing without a tool call.
src/resources/index.ts
  # Resource registration; server.ts gains the resources capability (still
  # transport-agnostic).
src/prompts/interpret-query.ts
  # MCP prompt: how to read query() output — expected discrepancies are noted,
  # a failed source slot means "no data from X", never "zero traffic"; compare
  # canonical metrics only. Audience rules: lead with the answer in business
  # terms, use businessMeaning wording instead of metric names, state caveats
  # in one plain sentence, and never require the reader to know what GA4 or
  # Cloudflare are to understand the conclusion.
src/prompts/site-report.ts
  # MCP prompt "site-report" (args: site, period): the packaged recipe for the
  # zero-skills user — walks the client through query across all bound sources,
  # explain-discrepancy on conflicts, then a business-language summary:
  # what happened, what changed, what deserves attention, what to check next.
  # The server supplies the recipe and the criterion; the client does the
  # reasoning and the writing.
src/tools/explain-discrepancy.ts
  # { metric, sourceA, sourceB, valueA, valueB, site? } -> deterministic:
  # actual ratio vs EXPECTED_DISCREPANCY (site expectations override when
  # configured), { isNormal, reason, suggestion }. Pure function over
  # knowledge.ts — trivially unit-tested, no network.
src/tools/validate-query.ts
  # Dry-run a QueryRequest against VALIDATION_RULES + site bindings + metric
  # coverage. Returns { valid, issues: [...] } — advisory, never blocks query().
src/instructions.ts
  # Update: point the client at analytics://metrics and the interpret-query
  # prompt before deep analysis.
  # ── Post-F2 implementation notes (binding, not optional) ──
  # Coverage is now fixed by src/core/normalize.ts — knowledge.ts documents
  # exactly these pairs, no others:
  #   pageviews: ga4=screenPageViews / cloudflare=pageviews (+requests alias) /
  #     vercel=pageviews;  sessions: ga4=sessions / cloudflare=visits;
  #   visitors: ga4=totalUsers / cloudflare=visits+uniques / vercel=visitors;
  #   clicks, impressions, ctr, position: gsc only.
  # REQUIRED caveats (from F2 review — the honesty this layer exists for):
  #   - cloudflare 'visits' serves BOTH sessions and visitors: it is an
  #     approximation, and comparing cf.sessions vs cf.visitors is meaningless.
  #   - CORRECTED at F2.5 implementation: cloudflare has TWO modes with
  #     opposite properties, selected at runtime by CLOUDFLARE_ACCOUNT_ID.
  #     RUM mode (account id set) reads rumPageloadEventsAdaptiveGroups — a JS
  #     beacon, so it undercounts like ga4. Edge mode (no account id) reads
  #     httpRequests1dGroups — raw edge requests including bots and assets, so
  #     it overcounts several times over. The expected ga4↔cloudflare gap
  #     therefore depends on the live mode; EXPECTED_DISCREPANCY carries an
  #     `edge` variant per pair rather than one blended number.
  #   - gsc metrics are search-only: never comparable against pageviews.
  # `expectations` lands as an optional block per site in sites.ts
  # (zod .strict() extension) and in sites.example.json with fictitious values.
  CRITERIA: unit tests for explain-discrepancy (normal / abnormal / unknown
  pair -> honest "no criterion for this pair", never a made-up range) and
  validate-query; resource render test. Gate S-F25-1.
  EXPLICITLY OUT: any LLM call inside the server; a suggest-next tool (pure
  client reasoning); per-site "normal" values hardcoded anywhere.
```

### Phase F3 — remote OAuth + Vercel entry

```
api/_shared/auth-state.ts, client-registry.ts, utils.ts
  # Generalize from a battle-tested private implementation (org strings removed):
  # - issuer/audience: env MCP_ISSUER, default 'analytics-mcp'.
  # - FRONTEND_URL from env (the Clerk-protected authorize page lives in the
  #   deployer's frontend, not this repo — README documents the contract).
  # - auth-state: Upstash REST, FAIL-CLOSED (store down -> invalid_grant/503,
  #   never skip single-use or revocation checks). ADR-F13 rationale applies.
api/register.ts, authorize.ts, token.ts, revoke.ts,
api/well-known/oauth-authorization-server.ts
  # OAuth 2.1 + PKCE, hardened contract: S256 pinned (reject other methods),
  # redirect_uri validated against signed client registry (errors returned,
  # never redirected), authorization codes single-use, refresh tokens carry
  # type:'refresh' and are REJECTED as access tokens, jti + subject revocation.
api/mcp.ts
  # Bearer verification: (1) Clerk session when CLERK_SECRET_KEY set,
  # (2) PAT JWT signed with MCP_SIGNING_SECRET. Optional ALLOWED_EMAIL_DOMAIN
  # check (empty = open). 401 + WWW-Authenticate: Bearer when absent/invalid
  # (this header is what triggers Claude web's OAuth flow). Then
  # StreamableHTTPServerTransport { sessionIdGenerator: undefined } over
  # createServer(). runtime nodejs, maxDuration 30.
vercel.json
  # framework null; functions map; rewrites /mcp, /register, /authorize, /token,
  # /revoke, /.well-known/* — same shape as the reference implementation.
  CRITERIA: §3 F3 gates (the CN set); handler unit tests with mocked stores.
```

### Phase F4 — dormant long-lived entry + entry smoke

```
src/serve.ts
  # The VPS seam. node:http server exposing the same StreamableHTTP handling as
  # api/mcp.ts (share the transport glue via a small src/http-handler.ts if it
  # avoids duplication — that file must stay transport-only, no business logic).
  # Auth: optional static bearer via env SERVE_BEARER_TOKEN (this entry targets
  # a private VPS behind Caddy; full OAuth stays a serverless concern).
  # PORT from env, default 8788. Not documented as the v1 deploy path — it exists
  # so the VPS/mcp-subprocess future is a new adapter + this entry, not a rewrite.
  CRITERIA: compiles in `pnpm check`; ONE smoke test: boots on a random port,
  answers initialize, shuts down. §3 F4 gate.
```

### Phase F5 — docs + CI

```
README.md
  # Full rewrite: pitch, architecture diagram, honest "remote = your deployment,
  # your credentials, not SaaS" note, per-source credential setup, Vercel deploy,
  # stdio client config, tool reference table, FRONTEND_URL authorize-page
  # contract, quota/cache notes, LICENSE.
.github/workflows/ci.yml
  # pnpm install --frozen-lockfile && pnpm verify (gates included). Node 20 + 22
  # matrix, 
  CRITERIA: `pnpm verify` green end to end; README contains no org references
  (grep gate S-F0-3 also covers docs).
```

---

## 3. Phase gates — `tests/gates/` (the tripwire)

`pnpm gates` = `pnpm build` + vitest with `vitest.gates.config.ts`, running
**against `dist/`** — spawned as a real process, or imported from `dist/` when
a test needs injection (`setSourcesForTests` is exported from the build).
Included in `pnpm verify`. Budget: ~15–20 tests total at F5 — no padding.

### Security suite — `tests/gates/security.gates.test.ts`

| ID | Phase | Assertion |
| --- | --- | --- |
| S-F0-1 | F0 | `.gitignore` covers `.env`, `.env.*`, `sites.config.json`, `scratch/`, `dist/` |
| S-F0-2 | F0 | Spawn dist with fake secrets in env (`UPSTASH_REDIS_REST_TOKEN=fake-secret-123`, etc.) + example SITES_CONFIG → `tools/list` and `list_sources` outputs do NOT contain any fake secret value |
| S-F0-3 | F0 | Tracked + unignored files contain no credential material: `-----BEGIN…PRIVATE KEY`, `AIza[0-9A-Za-z_-]{35}`, real-looking bearer strings; also greps docs for org names (decoupling tripwire — the forbidden list lives in an env-provided file OUTSIDE the repo, `GATES_FORBIDDEN_TERMS_FILE`, so the OSS repo never contains the terms it forbids; skip silently when unset) |
| S-F1-1 | F1 | `writeCapture` resolves only under `scratch/`; traversal (`../x`) rejected |
| S-F1-2 | F1 | Adapter upstream error with a 10KB body + Authorization header set → thrown message ≤ 400 chars and excludes the header value |
| S-F2-1 | F2 | `query_raw` with a source id outside SOURCE_IDS → schema rejection (allowlist), message lists valid ids |
| S-F25-1 | F2.5 | `src/semantics/` is org-free: forbidden-terms grep covers it and a structural check proves per-site expectations reach the module only via runtime config, never constants |
| S-F3-1 | F3 | `code_challenge_method=plain` → 400 (S256 pinned) |
| S-F3-2 | F3 | Unregistered / near-miss redirect_uri (`https://evil.example`, registered-host prefix tricks, `javascript:` scheme) → 400, never redirected |
| S-F3-3 | F3 | A refresh token presented as Bearer to /mcp → 401 |
| S-F3-4 | F3 | Auth-state store unavailable → token exchange fails (fail-closed), never issues |
| S-F3-5 | F3 | /mcp without Bearer → 401 + `WWW-Authenticate: Bearer` |
| S-F4-1 | F4 | stdio session: every stdout line parses as JSON-RPC (logs never leak into the MCP channel) |

### Performance suite — `tests/gates/perf.gates.test.ts`

Budgets, not benchmarks — generous enough for CI, tight enough to catch a
serial fan-out or an accidental sync-blocking import.

| ID | Phase | Assertion | Budget |
| --- | --- | --- | --- |
| P-F0-1 | F0 | Spawn `dist/index.js` → `initialize` round-trip (cold start ≈ serverless cold start) | < 3000 ms |
| P-F2-1 | F2 | 3 injected sources, 300 ms latency each → `query` wall time proves parallel fan-out | < 700 ms (serial would be ≥ 900) |
| P-F2-2 | F2 | 1 source hung 5 s, timeout 500 ms → response returns, slow slot = timeout error, other slots intact | < 1500 ms |
| P-F2-3 | F2 | Identical `query` twice → upstream called exactly once (second hit from cache) | call-count, no timer |
| P-F3-1 | F3 | `api/mcp` handler in-process, auth mocked, sources injected → initialize + tools/list | < 2000 ms |

---

## 4. Workflow per phase

1. **Agents implement** the phase's file contracts (this document only — no
   scope beyond the phase).
2. `pnpm verify` — unit + gates green is the definition of done.
3. **Code review** (Karen's session) against the contracts; findings fixed
   before close.
4. Conventional commit (`feat(f2): …`) + push. One phase, one commit.

F1 requires real credentials in local env before agents run `pnpm probe`; the
captures then get fictitious ids substituted before any fixture is committed.
