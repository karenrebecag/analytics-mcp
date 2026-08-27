# analytics-mcp Constitution

The project's authoritative implementation contract is **`SPEC.md`** (file
contracts in §2, phase gates in §3, workflow in §4). This constitution
distills the principles every speckit command and implementing agent must
honor; where more detail is needed, SPEC.md wins.

## Core Principles

### I. Org Decoupling (NON-NEGOTIABLE)
No organization name, property id, zone id, domain or token appears in code,
tests, fixtures or docs — ever. Business use is pure configuration
(`SITES_CONFIG` + env vars in a private deployment). Fixtures use fictitious
ids. Committed files are the open-source portfolio surface; the business
layer is never documented here.

### II. Probe Before Typing
No adapter or tool is typed against a guessed response shape — even for
documented APIs. `pnpm probe` captures real responses to `scratch/`
(gitignored); adapters and test fixtures derive from captures, with
fictitious ids substituted before anything is committed.

### III. The Seam Stays Clean
`createServer()` is host-agnostic: it imports nothing from Vercel, HTTP or
stdio. Environment switching exists in exactly two places — entry points
(`api/mcp.ts`, `src/index.ts`, `src/serve.ts`) and `src/sources/registry.ts`.
An environment `if` inside a tool is a bug, not a shortcut.

### IV. Secrets Never Transit Tool Output
Tools report credential *presence*, never values. Upstream error bodies are
truncated (≤400 chars); auth headers are never echoed. Error messages from
config parsing name paths, never values.

### V. Gates Are the Definition of Done (NON-NEGOTIABLE)
A phase is done when `pnpm verify` is green — typecheck, lint, format, unit
tests AND the build gates in `tests/gates/` (security S-* + performance P-*
cases, SPEC.md §3). Gates run against `dist/`, the compiled artifact.
**Never weaken, skip or delete a gate to make it pass.** A red gate means
the implementation is wrong, not the gate.

### VI. One Phase, No More
Implement only the current phase's file contracts (SPEC.md §2). No files,
tools, dependencies or scope beyond the phase. Dependencies are frozen:
runtime `@modelcontextprotocol/sdk` + `zod` (F3 adds `jose`,
`@clerk/backend`); Google JWTs are signed with `node:crypto`, not a
Google SDK.

## Additional Constraints

- pnpm, ESM `NodeNext`, TypeScript `strict`, single quotes, semicolons,
  printWidth 100. One tool per file in `src/tools/`, exporting `xSchema`
  (zod) + `handleX`; every handler routes through `runTool`.
- All tools are read-only in v1 (`readOnlyHint: true`). No write tools.
- Comments explain WHY, never WHAT. No emojis.
- Deliberate corner-cutting carries a `HACK:` comment naming the ceiling
  and the upgrade trigger.

## Development Workflow

1. Implementing agents build ONE phase to its SPEC.md §2 contracts.
2. `pnpm verify` green = definition of done (Principle V).
3. `/speckit-converge` against SPEC.md until Converged.
4. The supervising session code-reviews the diff against the contracts,
   then commits and pushes — one phase, one conventional commit
   (`feat(f0): …`).
5. Bug fixes follow assess → fix → test (`/speckit-bug-*`): validate the
   diagnosis with a failing test before patching; fix root cause in the
   shared path, not the symptom at one call site.

## Governance

This constitution and SPEC.md supersede ad-hoc practices. Amendments happen
by editing SPEC.md first (it is the contract), then syncing this distillation.
Complexity beyond a contract must be justified in the phase review or removed.

**Version**: 1.0.0 | **Ratified**: 2026-08-27 | **Last Amended**: 2026-08-27
