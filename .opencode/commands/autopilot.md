---
description: Full issue-to-merge autopilot — fix, review, address feedback, auto-merge
---

Run the full issue-to-merge workflow for GitHub issue #$ARGUMENTS on cloudflare/vinext.

## Phase 1: Fix the issue

1. Run `gh issue view $ARGUMENTS` to understand the issue.
2. Generate a short slug from the issue title (lowercase, hyphens, max 30 chars).
3. Create a worktree and branch:
   ```
   git fetch origin main
   git worktree add ../vinext-fix-$ARGUMENTS -b fix/$ARGUMENTS-<slug> origin/main
   ```
4. Install dependencies: run `pnpm install` in the worktree.
5. Fix the issue in `../vinext-fix-$ARGUMENTS/`. Follow AGENTS.md guidelines.
   - If touching server code, check dev/prod parity across all server files.
6. Run all checks from the worktree: `pnpm run build && pnpm test && pnpm run typecheck && pnpm run lint`
7. Commit: `fix: <description> (#$ARGUMENTS)`
8. Push: `git push -u origin fix/$ARGUMENTS-<slug>`
9. Create the PR:

   ```
   gh pr create --title "fix: <description>" --body "Fixes #$ARGUMENTS

   ## Summary
   <what changed and why>

   ## Test plan
   <what tests were added/updated>"
   ```

10. Note the PR number — you need it for Phase 2.

## Phase 2: Independent review

Invoke the reviewer subagent to get an independent review from a different model:

```
@reviewer Review pull request #<PR_NUMBER> on cloudflare/vinext.

1. Run gh pr view <PR_NUMBER> to understand the PR context.
2. Run gh pr diff <PR_NUMBER> to see all changes.
3. Read the full source files that were modified for surrounding context.
4. Check server parity if any server files were touched.
5. Post your review using gh pr review with inline comments.
```

Wait for the reviewer to finish before proceeding.

## Phase 3: Address review feedback

1. Read all review comments:

   ```
   gh pr view <PR_NUMBER> --comments
   gh api repos/cloudflare/vinext/pulls/<PR_NUMBER>/reviews
   gh api repos/cloudflare/vinext/pulls/<PR_NUMBER>/comments
   ```

2. For each comment:
   - **Fix needed**: Make the fix in the worktree
   - **Out of scope / pre-existing**: File a GitHub issue with `gh issue create` — include context from the review and a link to the PR. Do NOT skip this.
   - **Disagree**: Reply on the PR explaining why

3. Run all checks again: `pnpm run build && pnpm test && pnpm run typecheck && pnpm run lint`

4. Commit and push: `fix: address review feedback`

5. Reply to each addressed comment confirming the fix.

6. Enable auto-merge:
   ```
   gh pr merge <PR_NUMBER> --auto --squash --delete-branch
   ```

## Final output

Print a summary:

- PR URL
- What was fixed
- Review comments addressed (count)
- Follow-up issues filed (with links)
- Auto-merge status
- Worktree location and cleanup command: `git worktree remove ../vinext-fix-$ARGUMENTS`
