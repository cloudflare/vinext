---
description: Fix a GitHub issue end-to-end — worktree, branch, fix, tests, PR
---

Fix GitHub issue #$ARGUMENTS on cloudflare/vinext.

## Step 1: Understand the issue

Run `gh issue view $ARGUMENTS` to read the issue. Understand what's expected, what's broken, and any reproduction steps.

## Step 2: Create worktree and branch

Generate a short slug from the issue title (lowercase, hyphens, max 30 chars, no special chars).

```
git fetch origin main
git worktree add ../vinext-fix-$ARGUMENTS -b fix/$ARGUMENTS-<slug> origin/main
```

**All subsequent commands must target the worktree directory.** Use the bash tool's workdir parameter or explicit paths. Do NOT modify the main worktree.

Install dependencies in the worktree:
```
pnpm install
```

## Step 3: Fix the issue

Work in `../vinext-fix-$ARGUMENTS/`:

1. Research the codebase to understand the problem area
2. Implement the fix following the patterns described in AGENTS.md
3. **If touching server code**, check dev/prod parity across:
   - `server/app-dev-server.ts`
   - `server/dev-server.ts`
   - `server/prod-server.ts`
   - `cloudflare/worker-entry.ts`
4. Add or update tests as appropriate

## Step 4: Verify

Run all checks from the worktree:
```
pnpm run build
pnpm test
pnpm run typecheck
pnpm run lint
```

Fix any failures before proceeding.

## Step 5: Commit and create PR

1. Stage and commit with a clear message: `fix: <description> (#$ARGUMENTS)`
2. Push: `git push -u origin fix/$ARGUMENTS-<slug>`
3. Create PR:
```
gh pr create \
  --title "fix: <description>" \
  --body "Fixes #$ARGUMENTS

## Summary
<1-3 bullet points explaining what changed and why>

## Test plan
<what tests were added/updated>"
```

4. Print the PR URL and number at the end. The review step needs the PR number.
