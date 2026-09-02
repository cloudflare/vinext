# Diagnose

Find the root cause of a reproduced bug in the vinext source code.

**CRITICAL: You MUST always read `report.md` and append to `report.md` before finishing, regardless of outcome. Even if you cannot identify the root cause, hit errors, or the investigation is inconclusive — always update `report.md` with your findings. The orchestrator and downstream skills depend on this file to determine what happened.**

**SCOPE: Your job is diagnosis only. Finish your work once you've completed this workflow. Do NOT go further than this (no larger verification of the issue, no fixing of the issue, etc.). Do not spawn tasks/sub-agents.**

## Prerequisites

- **`triageDir`** — Directory containing the reproduction project (e.g. `triage/gh-123`). If not passed as an arg, infer from previous conversation.
- **`issueDetails`** — The GitHub API issue details payload. If not available, run `gh issue view ${issue_number}`.
- **`report.md`** — File in `triageDir` written by the reproduce skill. Contains the full context from reproduction.

## Overview

1. Review the reproduction and error details from `report.md`
2. Locate the relevant source files in `packages/`
3. Add instrumentation to understand the code path
4. Identify the root cause
5. Append diagnosis findings to `report.md`

## Step 1: Review the Reproduction

Start by reading `report.md` from the `triageDir` directory.

**Skip if not reproduced:** If `report.md` shows the bug was NOT reproduced or was skipped, append "DIAGNOSIS SKIPPED: No reproduction" to `report.md` and return `confidence: null`.

Re-run the reproduction if needed to see the error firsthand (see reproduce.md for the commands).

Before diving into source, read the repo's `AGENTS.md` — it documents the architecture invariants that explain many behaviors that look like bugs but are deliberate (RSC/SSR as separate Vite environments, request execution order, ISR layering).

## Step 2: Locate Relevant Source Files

Using the error messages, stack traces, and reproduction details from Step 1, identify the source files that are likely involved. The map:

| Area | Where it lives |
| --- | --- |
| Vite plugin, `next/*` resolution, virtual modules | `packages/vinext/src/index.ts` |
| `next/link`, `next/navigation`, `next/image`, and other shims | `packages/vinext/src/shims/` |
| File-system routing (`app/`, `pages/` scanners) | `packages/vinext/src/routing/` |
| Pages Router SSR (dev + prod) | `packages/vinext/src/server/dev-server.ts`, `server/prod-server.ts` |
| App Router RSC entry generation | `packages/vinext/src/entries/` |
| Request lifecycle, ISR, cache | `packages/vinext/src/server/` |
| Cloudflare deploy, KV cache, worker entry | `packages/cloudflare/`, `packages/vinext/src/cloudflare/` |
| `next` type surface | `packages/types/` |
| CLI (`vinext init`, `vinext check`) | `packages/vinext/src/cli.ts` |

**Dev/prod parity:** the same request path often exists in four places that are supposed to stay in sync — `entries/app-rsc-entry.ts` (App Router dev), `server/dev-server.ts` (Pages Router dev), `server/prod-server.ts` (Pages Router prod), and the Cloudflare worker entry. A bug fixed in one and not the others is a known failure mode; check them all when you find the culprit.

## Step 3: Investigate with Instrumentation

Add `console.log` statements to understand the code path:

```typescript
// e.g. in packages/vinext/src/server/prod-server.ts
console.log('[DEBUG] matched route:', route);
console.log('[DEBUG] request headers:', JSON.stringify(headers, null, 2));
```

After adding logs:

1. Rebuild the affected package: `vp run vinext#build` (or `vp run build` at the repo root for everything)
2. Re-run the reproduction
3. Observe the debug output

**Server management:** If re-running requires a dev server, always stop the existing server first (`kill "$(cat /tmp/vinext-dev.pid)"`). If the server fails to start twice, bail out — write your diagnosis with the data you have. Prefer `vp run build` over dev servers when possible.

Iterate until you understand:

- What code path is executing
- What data is being passed
- Where the logic diverges from expected behavior

When the reproduction runs against Next.js-observable behavior, the local Next.js clone (see below) tells you what the value *should* be.

Once done, **revert all instrumentation** before moving on (`git checkout -- <file>`). Debug logs must not leak into downstream steps.

## Step 4: Identify Root Cause

Once you understand the issue, document:

1. **Which file(s)** contain the bug
2. **What the code does wrong** — the specific logic error
3. **Why this causes the observed behavior** — how the error manifests
4. **What the fix should be** — high-level approach

Consider:

- Is this a regression from a recent change? (`git log --oneline -- <file>`, `git blame`)
- Does it affect the other parity files listed in Step 2?
- Are there edge cases — null/undefined inputs, empty routes, streaming edge cases?
- Never suggest removing a user's dependency (adapters, plugins, MDX, Nitro) as a fix — those are things the user needs. The fix must work within the user's existing stack.

### The Next.js reference clone

vinext's behavioral spec is Next.js. A shallow clone of the Next.js repo at `.nextjs-ref/` (gitignored) is the ground truth for how upstream implements a behavior:

```bash
# Only if it does not already exist
git clone --depth 1 --single-branch --branch canary https://github.com/vercel/next.js.git .nextjs-ref
```

Use it to read the upstream implementation of the code path you are diagnosing. If vinext's logic diverges from upstream's handling of the same input, that divergence is usually the root cause.

**Tone calibration:** Describe the root cause factually, not dramatically. Avoid language that overstates impact ("critical flaw", "fundamentally broken") unless the evidence genuinely supports it. A missing null check is a missing null check. The diagnosis should help a maintainer understand what's wrong and guide them towards a fix, not alarm them.

## Step 5: Write Output

Append your diagnosis findings to the existing `report.md` (written by the reproduce skill).

Include a new section with everything you learned: the root cause, affected files with line numbers, detailed explanation of the code path, instrumentation results, and your suggested fix approach. This helps the fix skill work faster.

The report must include all information needed for a final GitHub comment to be generated later by the comment skill. Make sure to include:

- Root cause explanation (which files, what logic is wrong, why)
- Affected file paths with line numbers
- Suggested fix approach
- Confidence level (`high`, `medium`, or `low`) and any caveats
