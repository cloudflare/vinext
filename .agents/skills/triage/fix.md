# Fix

Develop and verify a fix for a diagnosed vinext bug.

**CRITICAL: You MUST always read `report.md` and append to `report.md` before finishing, regardless of outcome. Even if the fix attempt fails, you encounter errors, or you cannot resolve the bug — always update `report.md` with your findings. The orchestrator and downstream skills depend on this file to determine what happened.**

**SCOPE: Do not spawn tasks/sub-agents.**

## Prerequisites

- **`triageDir`** — Directory containing the reproduction project (e.g. `triage/gh-123`). If not passed as an arg, infer from previous conversation.
- **`issueDetails`** — The GitHub API issue details payload. If not available, run `gh issue view ${issue_number}`.
- **`report.md`** — File in `triageDir` containing the full context from all previous skills.

## Overview

1. Review the diagnosis from `report.md`
2. Verify fix feasibility
3. Implement a minimal fix in `packages/`
4. Rebuild the affected package(s)
5. Verify the fix resolves the reproduction
6. Write a test
7. Ensure no regressions
8. Generate git diff
9. Append fix details to `report.md`
10. Clean up the working directory

## Step 1: Review the Diagnosis

Read `report.md` from the `triageDir` directory to understand the root cause, affected files, and suggested approach.

**Skip if prerequisites unmet:** If `report.md` shows the bug was not reproduced, was skipped, or was verified as intended behavior → append "FIX SKIPPED: <reason>" to `report.md` and return `fixed: false`. Do NOT attempt a fix based on guesswork.

**Low-confidence path:** If diagnosis confidence is `low` or `null`, or no clear root cause was found → do NOT attempt a code fix. Instead:

1. Identify the most likely area(s) of the codebase related to the issue.
2. If possible, write a failing test that demonstrates the expected behavior described in the issue, placed per the conventions in Step 6. A failing test is valuable even without a fix — it documents the bug.
3. If you identified specific code paths, add brief inline comments (prefixed `// TRIAGE:`) near the most relevant lines to help the implementor orient quickly. Keep to 2-3 comments max.
4. Append to `report.md`: the areas you identified, why they seem relevant, and any failing test or comments you added.
5. Return `fixed: false`.

This "breadcrumb" approach is more useful to maintainers than a wrong fix.

**High-confidence path:** If diagnosis confidence is `medium` or `high` and a clear root cause was identified → implement a fix as described below.

**Note:** The repo may be messy from previous steps (instrumentation logs, repro changes). Check `git status` — revert leftover instrumentation (`git checkout -- packages/`) so only intentional fix changes remain.

## Step 2: Verify Fix Feasibility

- **Runtime targets:** Server code must run on Node.js 22+ and Cloudflare Workers (workerd). Do not use Node-only APIs in code paths that run in Workers; when Node built-ins are needed and available in workerd (e.g. `node:crypto`, `node:util`), prefer them over new dependencies.
- **Browsers:** If the fix touches client shims, only rely on web platform features with broad support. Do not treat specification compliance as proof of browser support.
- **Dependencies:** Do not add a new dependency to fix a bug. Use Node built-ins or existing dependencies.

## Step 3: Implement the Fix

Make changes in `packages/*/src` files. Follow these principles:

**Keep it minimal:**

- Only change what's necessary to fix the bug
- Don't refactor unrelated code
- Don't add new features
- **Never "fix" an issue by removing a user's dependency.** Removing an adapter, plugin, MDX, Nitro, or a `next.config.js` option is not a fix — those are things the user needs. The fix must work with the user's existing stack.

**Follow repo conventions (read `AGENTS.md` first if you haven't):**

- Source files under `packages/vinext/src` import `path` from `pathslash`, never `node:path`. Apply `toSlash` only at external boundaries (`process.cwd()`, `fileURLToPath`, bundler-reported ids). Never add unconditional `.replaceAll("\\", "/")` to source.
- Tests build fixture inputs with native `node:path`; only expectations compared against source output use canonical (forward-slash) form.
- Do not touch URL-space backslash defenses (request-pathname sanitizers).

**Dev/prod parity:** the same request path exists in up to four places that must stay in sync — `entries/app-rsc-entry.ts` (App Router dev/RSC entry), `server/dev-server.ts` (Pages Router dev), `server/prod-server.ts` (Pages Router prod), and the Cloudflare worker entry (`packages/cloudflare`, `packages/vinext/src/cloudflare`). If the bug lives in request handling, check whether the same bug exists in the sibling implementations and fix them all in this change. Do not leave a known instance as a follow-up.

**Consider edge cases:**

- Will this break other use cases (empty routes, streaming, concurrent requests)?
- What happens with unusual input?
- Are there null/undefined checks needed?

## Step 4: Rebuild the Package

After making changes, rebuild:

```bash
vp run vinext#build   # or the affected package, e.g. vp run cloudflare#build
# or from the repo root: vp run build
```

Watch for build errors — fix any TypeScript issues before proceeding.

**The build output must be present and current when you finish**: after the fix, the orchestrator packs the changed `packages/*` directories and publishes them as a preview release the reporter installs. If `dist/` is stale, the preview tests the wrong code.

## Step 5: Verify the Fix

Re-run the reproduction from `report.md` (build or dev server — see reproduce.md for the commands). Confirm the reported behavior now matches what the issue's expected result describes, and confirm the baseline still works.

## Step 6: Write a Test

Write a test that covers the bug you just fixed. It should fail without the fix and pass with it.

Follow the repo's conventions — tests live in `tests/*.test.ts` (unit + integration mixed, run with vitest). Pick the file by area, or add a new one following an existing file's shape:

| If the fix touches... | Test file |
| --- | --- |
| A shim (`shims/*.ts`) | `tests/shims.test.ts` or the specific shim test (e.g. `tests/link.test.ts`) |
| Routing (`routing/*.ts`) | `tests/routing.test.ts`, `tests/route-sorting.test.ts` |
| App Router server / entries | `tests/app-router.test.ts`, `tests/features.test.ts` |
| Pages Router server | `tests/pages-router.test.ts` |
| Caching / ISR / KV | `tests/isr-cache.test.ts`, `tests/fetch-cache.test.ts`, `tests/kv-cache-handler.test.ts` |
| Build / deploy | `tests/deploy.test.ts`, `tests/build-optimization.test.ts` |
| Next.js compat behavior | the relevant `tests/nextjs-compat/` file |

If Next.js has a test for this behavior, port it and credit it:

```ts
// Ported from Next.js: test/e2e/<area>/<name>/<name>.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/<area>/<name>/<name>.test.ts
```

Run it in isolation to confirm it passes:

```bash
vp test run tests/<file>.test.ts
```

If the test fails, fix either the test or the implementation until it passes. If you cannot write a meaningful test, document why in `report.md` and move on — do not force a test that doesn't make sense.

## Step 7: Check for Regressions

Test that you didn't break anything else:

```bash
vp run check     # format, lint, type checks
```

Then run the test files that cover the area you changed (see the table above); the full suite runs in CI. Address failures until everything passes.

## Step 8: Generate Git Diff

From the repository root:

```bash
git diff packages/
```

This captures all your changes for the report.

## Step 9: Commit Message Convention (replaces changesets)

**Do NOT create a `.changeset/*.md` file.** Release changesets are generated automatically from Conventional Commit subjects during CI (`scripts/create-changeset.mjs`). A hand-authored changeset would conflict with that automation.

The orchestrator commits your work with a commit message you provide. Make it a well-formed Conventional Commit, because it becomes the release changelog entry verbatim:

```
fix(<scope>): <one-line, user-facing description in present tense>
```

- `fix()` for bug fixes, `feat()` for behavior additions, `perf()`, `docs()`, `chore()` as appropriate
- Common scopes: `shims`, `router`, `cache`, `isr`, `build`, `server`, `cloudflare`, `cli`, `deploy`, `types`, `docs`, `ci`
- Name the affected API and what now works: `fix(shims): preserve query params in useRouter().push()`
- Write for vinext users, not reviewers — one line, present tense, no issue reference needed (the PR links the issue)

Return the commit message as your `commitMessage` structured result field (and mirror it in `report.md` under "Commit message") — the orchestrator commits the fix branch with it.

## Step 10: Write Output

Append your fix details to the existing `report.md` (written by reproduce/diagnose/verify skills).

Include a new section with:

- What was changed and why
- The full git diff (unless it is massive)
- Whether the fix was successful or not
- Verification results (did the fix resolve the original reproduction?)
- Test details: what test was added, where it lives, what it verifies. If none, explain why.
- Dev/prod parity: which of the sibling implementations (App Router entry, Pages Router dev/prod servers, worker entry) you checked and what you changed in each
- Any alternative approaches considered and their tradeoffs
- The commit message (Step 9)
- If the fix failed: what was tried and why it didn't work

## Step 11: Clean Up the Working Directory

1. Run `git status` and review all changed files
2. Revert changes that are NOT part of the fix:
   - Debug code, `console.log`s, or temporary test files
   - **`pnpm-lock.yaml`** — reproduction installs modify it; the lockfile must stay untouched (`git checkout -- pnpm-lock.yaml`)
   - Changes to `examples/`, `tests/fixtures/`, or other files that were only needed for diagnosis/reproduction
   - Build artifacts that shouldn't be committed
3. Use `git checkout -- <file>` to discard unwanted changes
4. Confirm with a final `git status` that only the intended fix files remain (a `.changeset/` file must NOT be among them)
5. DO NOT commit or push anything yourself — the orchestrator commits and pushes the fix branch

The `triage/` directory is gitignored, so it won't appear in `git status`.
