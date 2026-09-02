# Reproduce

Reproduce a GitHub issue to determine if a bug is valid and reproducible.

**CRITICAL: You MUST always read `report.md` and write `report.md` to the triage directory before finishing, regardless of outcome. Even if you encounter errors, cannot reproduce the bug, hit unexpected problems, or need to skip — always write `report.md`. The orchestrator and downstream skills depend on this file to determine what happened. If you finish without writing it, the entire pipeline fails silently.**

**SCOPE: Your job is reproduction only. Finish your work once you've completed this workflow. Do NOT go further than this (no larger diagnosis of the issue, no fixing of the issue, etc.). Do not spawn tasks/sub-agents.**

## Prerequisites

These variables are referenced throughout this skill. They may be passed as args by an orchestrator, or inferred from the conversation when run standalone.

- **`triageDir`** — Directory containing the reproduction project (e.g. `triage/gh-123`). If not passed as an arg, infer from previous conversation. Default: `triage/gh-<issue_number>`.
- **`issueDetails`** — The GitHub API issue details payload. This must be provided explicitly by the user or available from prior conversation context / tool calls. If this data isn't available, you may run `gh issue view ${issue_number}` to load the missing issue details directly from GitHub.

## Overview

1. Confirm the issue details
2. Analyze the issue for early exit conditions
3. Set up a reproduction project in the triage directory
4. Attempt to reproduce the bug
5. Write `report.md` with detailed findings

## Step 1: Confirm Bug Details

Confirm that you have `issueDetails` as defined/instructed above. **Otherwise**, fail — we cannot triage a bug that we have no details on.

Once you have `issueDetails`, read carefully:

- The bug description and expected vs actual behavior
- Any reproduction steps provided
- Environment details (vinext version, Next.js version, deployment target — Node vs Cloudflare Workers vs Nitro)
- Comments that might clarify the issue

## Step 2: Check for Early Exit Conditions

Before attempting reproduction, check if this issue should be skipped due to a limitation of our sandbox reproduction environment.

If any early exit condition is met, skip to Step 5 and write `report.md` with the skip details.

**Comment Handling for Early Exits:** Sometimes future comments will provide additional reproductions. An early exit is only valid if no future comments in that issue "invalidate" it. For example, if the original poster reported the bug on an old vinext release but a commenter later posted the same reproduction on the latest release, the early exit is no longer valid — continue with the workflow instead.

The documented early exit conditions we support:

### Not Actionable (`not-actionable`)

Skip if the issue is not a bug report. This workflow can only triage bugs — feature requests, suggestions, and discussions are not actionable here.

### Missing Details (`missing-details`)

Skip if the issue is missing a valid reproduction (see below for the list of supported valid reproductions), or is missing a description of the user's expected result. We need both to successfully reproduce, and later to verify the expected results.

### Host-Specific Issues (`host-specific`)

Skip if the bug can only be reproduced on deployed infrastructure that the sandbox cannot emulate. Note that **most** Cloudflare-specific behavior IS reproducible locally: `vite dev` in a project using `@cloudflare/vite-plugin` runs server code in workerd, so Workers runtime semantics (bindings via `cloudflare:workers`, `Cache API`, KV) reproduce with a dev server or build. Only skip when the bug genuinely requires a deployed environment: production-only routing (custom domains, workers.dev zone behavior), live Durable Object state, production KV/R2 contents, or tunnel/auth infrastructure.

### Runtime-Specific Issues (`unsupported-runtime`)

Skip if the bug is specific to Bun or Deno as a host runtime. vinext supports Node.js, Cloudflare Workers, and Nitro presets.

### Maintainer Override (`maintainer-override`)

Skip if a repository maintainer has commented that this issue should not be reproduced here. To determine if a commenter is a maintainer, check the `authorAssociation` field on their comment in `issueDetails` — values of `MEMBER`, `COLLABORATOR`, or `OWNER` indicate a maintainer.

## Step 3: Set Up Reproduction Project

Every bug report should include some sort of reproduction. The reproduction project goes in the `triageDir` directory (e.g. `triage/gh-123`). If no `triageDir` is provided, default to `triage/gh-<issue_number>`.

`triage/*` is part of the pnpm workspace, so a reproduction project there resolves `"vinext": "workspace:*"` to the local `packages/` sources — this is how we test the current main branch.

**IMPORTANT:** Installing the reproduction modifies `pnpm-lock.yaml` (new workspace importer). That is expected and will be reverted in the fix step — never commit it.

### StackBlitz Project URL (`https://stackblitz.com/edit/...`)

If reproduction was provided as a StackBlitz project URL, download it into the `triageDir` directory using `stackblitz-clone`:

```bash
npx stackblitz-clone@latest <stackblitz-url> <triageDir>
```

### StackBlitz GitHub URL (`https://stackblitz.com/github/...`)

Parse out the GitHub org & repo names and treat it as a GitHub URL, following the "GitHub URL" step below.

### GitHub URL (`https://github.com/...`)

If reproduction was provided as a GitHub repo URL, clone the repo into the triage directory and remove the `.git` directory to avoid conflicts with the host repo:

```bash
git clone --depth 1 https://github.com/<owner>/<repo>.git <triageDir>
rm -rf <triageDir>/.git
```

If a specific branch or subdirectory is referenced, check out that branch before removing `.git`, or copy only the relevant subdirectory.

Cloned repos run with your sandbox's network access and the repository's install scripts. Keep this in mind and prefer the smallest possible reproduction; do not enter credentials into anything.

### Gist URL (`https://gist.github.com/`)

Fetch the gist contents using the GitHub API to help understand the reproduction:

```bash
curl -s "https://api.github.com/gists/<gist-id>"
```

You may still need to set up a project from scratch (see fallback below) and apply the gist files into it.

### Manual Steps Reproduction

If no reproduction URL is provided, follow the manual steps the user provided. Build the reproduction from one of the existing workspace apps — pick the smallest one that matches the report:

| App | Use when |
| --- | --- |
| `tests/fixtures/app-basic` | App Router basics |
| `tests/fixtures/pages-basic` | Pages Router basics |
| `examples/app-router-cloudflare` | App Router + Cloudflare bindings/Workers behavior |
| `examples/pages-router-cloudflare` | Pages Router + Cloudflare |
| `examples/app-router-playground` | MDX, Tailwind, richer features |

Copy it into the triage directory:

```bash
rm -rf examples/<template>/node_modules   # avoid problems with cp -r
cp -r examples/<template> <triageDir>
```

Then link it into the workspace (from the repo root):

```bash
vp install --no-frozen-lockfile
```

Verify the project was created in the correct place (`cat <triageDir>/package.json`).

Then, modify the triage project as needed to attempt your reproduction:

1. Update `vite.config.ts` with required configuration changes (vinext plugin options, additional plugins)
2. Add/modify any dependencies or plugins (`@vitejs/plugin-react`, MDX, Tailwind)
3. Add/modify any pages, layouts, route handlers, middleware, or `next.config.js` settings that trigger the bug
4. Add/modify any additional files mentioned in the issue

Keep the reproduction as minimal as possible — only add what the issue reporter has documented as needed to trigger the bug.

## Step 4: Attempt Reproduction in the Triage Project

Use all of the tools at your disposal — `vp run build`, `vite dev`, `curl`, the vitest suite, etc.

1. **Trigger the bug.** Follow the reproduction steps from the issue and confirm that the bug appears.
2. **Verify the baseline.** Remove or reverse the triggering code and confirm the project works without the bug. This guards against false positives — if the project is still broken without the triggering code, the issue may be in your setup, not the reported bug.
3. **Document what you observe.** Record exact error messages and stack traces, which command triggers the issue, and whether it's consistent or intermittent.

For dev-server bugs (`vite dev`) and for Workers-runtime behavior (bindings, workerd semantics), start a dev server in the background and drive it with `curl`:

```bash
cd <triageDir>
nohup npx vite dev --port 4321 --host 127.0.0.1 > /tmp/vinext-dev.log 2>&1 &
echo $! > /tmp/vinext-dev.pid
sleep 5 && cat /tmp/vinext-dev.log
curl -s http://127.0.0.1:4321/ | head -100
kill "$(cat /tmp/vinext-dev.pid)" 2>/dev/null || true
```

For build bugs, `cd <triageDir> && vp run build` and inspect `dist/` output. For deploy-output bugs, also inspect the generated `dist/server/wrangler.json` and worker bundles.

Many routing/shim bugs are fastest to reproduce as a vitest fixture — if the bug fits that shape, check `tests/fixtures/` and the test helpers used by an existing test file that covers the same area, and write a scratch fixture instead of driving a server.

### Server Management Rules

Running dev servers is often necessary, but server problems must not consume your time budget:

- **Bail out after 2 failed server starts.** If the server fails to start twice in a row, stop trying. Do NOT loop with variations. Write your report with what you already know.
- **Always stop servers before restarting.** `kill "$(cat /tmp/vinext-dev.pid)"` first; `pkill -f "vite dev"` as a fallback. If a port stays blocked, use a different port rather than fighting the stale process.
- **One reproduction run is enough.** Once you have confirmed or denied the bug, do NOT restart the server to re-test minor config variations. Additional testing belongs in the diagnose step. Write your findings and move on.
- **Prefer `vp run build` over a dev server when possible.** Build-time reproduction avoids server lifecycle issues entirely. Only use dev servers when the bug specifically requires a running server (HMR, dev SSR, request handling, middleware).
- **Never leave a server running** when you finish — always kill it.

## Step 5: Write Output

Write `report.md` to the triage directory:

### `report.md` — Detailed internal report for the next LLM stage

Write a verbose report with everything you learned. This is NOT for humans — it's context for the next stage of the pipeline (diagnose/fix). **Downstream skills will NOT have access to the original issue — `report.md` is their only source of context.** Include:

- The original issue title, description, and any relevant details from the issue body. It's better to include too much context from the original issue vs. too little.
- Full environment details (vinext version, Node version, router type, deployment target)
- All steps attempted and their results
- Complete error messages and stack traces
- Observations about the codebase, theories about root cause
- Anything that would help the next stage work faster

Be thorough. More context is better here.

The report must include all information needed for a final GitHub comment to be generated later by the comment skill. Make sure to include:

- Environment details (package versions, Node.js version, router, deployment target)
- Steps to reproduce (numbered list)
- Expected vs actual result
- Error messages and stack traces
- Whether the issue was reproduced, not reproduced, or skipped (and why)
