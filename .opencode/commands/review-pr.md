---
description: Review a PR using the reviewer agent (different model)
agent: reviewer
---

Review pull request #$ARGUMENTS on cloudflare/vinext.

## Steps

1. **Read context**: Run `gh pr view $ARGUMENTS` to understand the PR — what issue it fixes, what the author claims it does.

2. **Read the diff**: Run `gh pr diff $ARGUMENTS` to see every change.

3. **Read full files**: For each modified file, read the complete file (not just the diff) so you understand the surrounding code and can catch issues the diff alone won't reveal.

4. **Check server parity**: If any of these files were touched, check whether the others need matching changes:
   - `packages/vinext/src/server/app-dev-server.ts`
   - `packages/vinext/src/server/dev-server.ts`
   - `packages/vinext/src/server/prod-server.ts`
   - `packages/vinext/src/cloudflare/worker-entry.ts`

5. **Check test coverage**: Are the changes tested? Are edge cases covered? Run `gh pr diff $ARGUMENTS` again filtered to test files if needed.

6. **Post review**: Use `gh pr review $ARGUMENTS` with your assessment:
   - `--approve` if the PR is clean
   - `--request-changes --body "..."` if there are blocking issues
   - `--comment --body "..."` if there are only suggestions

   For inline comments on specific files/lines, use:
   ```
   gh api repos/cloudflare/vinext/pulls/$ARGUMENTS/comments -f body="..." -f path="..." -F line=N -f side="RIGHT"
   ```

Be thorough. This is the only review gate before merge.
