# CLAUDE.md — analytics-mcp

Open-source unified web-analytics MCP server (GA4 + Cloudflare + Vercel +
GSC). Read `SPEC.md` before changing anything structural.

## Non-negotiable rules

1. **The org decoupling.** No organization name, property id, zone id, domain
   or token appears in code, tests, fixtures or docs — ever. Business use is
   pure configuration (`SITES_CONFIG` + env). Fixtures use fictitious ids.
2. **Probe before typing.** No adapter or tool is typed against a guessed
   response shape. Run `pnpm probe` (F1+), read the capture in `scratch/`,
   type against that. This repo inherits the rule from PowerAutomate_mcp and
   it applies even to documented APIs — docs drift, captures don't.
3. **The seam stays clean.** `createServer()` imports nothing from
   Vercel/HTTP/stdio. Environment switching lives only in entry points
   (`api/mcp.ts`, `src/index.ts`, `src/serve.ts`) and `sources/registry.ts`.
   An environment `if` inside a tool is a bug, not a shortcut.
4. **Secrets never transit tool output.** `list_sources` reports presence
   (`configured: true`), never values. Upstream error bodies are truncated;
   auth headers are never echoed.

## Conventions (inherited from PowerAutomate_mcp)

- ESM (`NodeNext`), `strict`, single quotes, semicolons, printWidth 100.
- One tool per file in `src/tools/`, exporting `xSchema` (zod) + `handleX`.
- All tools read-only in v1; every handler routes through `runTool`.
- `pnpm verify` = check + lint + format:check + test + gates. Run before
  calling any phase done.

## Phase gates

`pnpm gates` builds and runs `tests/gates/` against `dist/` — small
security + performance suites that grow per phase (see SPEC.md § Phase
gates). They spawn the compiled server; they are excluded from `pnpm test`.

## Scope

In v1: read-only analytics across the 4 sources, normalized `query`, raw
escape hatch, OAuth 2.1 remote + stdio local. Out: writes of any kind,
multi-tenant auth, the `mcp-subprocess` adapter (interface exists, no impl).

## Workflow (spec-driven, multi-agent)

Implementation agents build ONE phase at a time, exactly to the file
contracts in `SPEC.md` §2 — no files or scope beyond the phase. Definition
of done = `pnpm verify` green (unit + gates). The gates in `tests/gates/`
are the tripwire for contract violations; do not weaken a gate to make it
pass. After green, the supervising session code-reviews the diff against
the contracts, then commits and pushes — one phase, one conventional commit.
