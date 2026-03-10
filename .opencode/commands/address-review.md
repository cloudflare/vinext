---
description: Address PR review comments, file follow-up issues, enable auto-merge
---

Address review comments on PR #$ARGUMENTS for cloudflare/vinext.

## Step 1: Read all review feedback

```
gh pr view $ARGUMENTS --comments
gh api repos/cloudflare/vinext/pulls/$ARGUMENTS/reviews
gh api repos/cloudflare/vinext/pulls/$ARGUMENTS/comments
```

## Step 2: Categorize each comment

For every review comment, decide:

- **Fix needed**: A legitimate issue introduced by this PR. Fix it.
- **Out of scope / pre-existing**: A real problem, but not introduced by this PR. File a GitHub issue to track it.
- **Disagree**: The reviewer is wrong or it's a style preference. Reply explaining why.

## Step 3: Make fixes

Work in `../vinext-fix-$ARGUMENTS/`:

1. Address each legitimate comment with a code fix
2. Run the full check suite:
   ```
   pnpm run build
   pnpm test
   pnpm run typecheck
   pnpm run lint
   ```
3. Commit: `fix: address review feedback`
4. Push

## Step 4: File follow-up issues

For each out-of-scope finding, create a tracked issue:

```
gh issue create \
  --title "<concise description>" \
  --body "Identified during review of #$ARGUMENTS.

## Context
<what was found and why it matters>

## Suggested approach
<if you have one>"
```

Do NOT skip this. The whole point is to avoid losing track of work.

## Step 5: Reply to review comments

For each comment that was addressed, reply confirming the fix:

```
gh api repos/cloudflare/vinext/pulls/$ARGUMENTS/comments/{comment_id}/replies \
  -f body="Fixed in <commit sha>"
```

For disagreements, reply with your reasoning.

## Step 6: Enable auto-merge

```
gh pr merge $ARGUMENTS --auto --squash --delete-branch
```

## Step 7: Summary

Print a final summary:

- Comments addressed (with commit references)
- Follow-up issues filed (with issue numbers and links)
- Auto-merge status
