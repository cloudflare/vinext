---
name: fix
description: Opt-in workflow for fixing one GitHub issue end to end. Invoked only via `/fix <github-issue-url>` (`$fix` in Codex). Reproduces the bug with our own fixtures, implements the root-cause fix, gets clean independent reviews, opens a draft pull request, makes CI green, runs the Big Bonk review loop and marks the PR ready.
argument-hint: <github-issue-url>
disable-model-invocation: true
metadata:
  # Maintainer-only: keeps `npx skills add cloudflare/vinext` from offering it.
  internal: true
---

# Fix GitHub Issue

Issue: $ARGUMENTS

Take ownership of the issue from investigation through a review-ready pull request. Do not stop at a diagnosis, a speculative patch or a locally passing test.

Establish the issue's live state below, then follow [`references/rules.md`](references/rules.md) to confirm, reproduce, fix, validate and write the PR. Its "Automated Runs" section doesn't apply here. This file covers the review and CI loops that follow.

## Input

Require one GitHub issue URL, passed as the `/fix` argument. If it is missing, ask for it. If it names a repository other than the current checkout, find an existing checkout of that repository before editing.

## Hard Rules

- **Fix against current main.** Run `git fetch origin main` and branch from it. The local `main` ref is often stale: squash or diff against `git merge-base HEAD origin/main`, never local `main`.
- **Protect the GitHub API budget.** Every session and automation on the account shares the quota. Prefer plain `gh` reads, keep `first:` small, and stop when fewer than ~1,500 calls remain.
- **Don't let a Bonk trigger get dropped.** A running Big Bonk review is never cancelled, but a trigger posted while one runs waits as pending, and any later PR comment or review-thread reply (Bonk's own included) replaces it. Batch replies into the trigger comment, and post nothing else on the PR until that trigger's run has started.
- **Finish the feature.** If a finding is in the PR's scope and the fix is clear, fix it without asking. Stop and ask only when the PR's direction is wrong, the fix would balloon past its scope, it needs a new dependency, or parity and the request conflict.

## 1. Establish Live State

1. Parse the URL into owner, repository and issue number. Read the issue, every comment, linked PRs and cross-references with `gh`.
2. Look for an existing branch, open PR or merged fix (`gh pr list --search "<number>"`, `git log origin/main --grep`). Continue an existing PR instead of duplicating it. Before pushing to or stacking on a PR, check `gh pr view <n> --json state`: a squash-merged branch still looks unmerged to git.
3. Confirm the checkout, branch and working-tree status. Preserve unrelated changes. Create a focused branch (`fix/<short-slug>`), or use the fresh worktree branch created for this task.
4. Read `AGENTS.md`, then work through `references/rules.md` up to its PR section.

## 2. Independent Review

After the fix and focused validation pass, spawn one independent review sub-agent.

- Give it the issue URL, repository path, the cumulative diff or branch, `AGENTS.md`, `references/rules.md` and the validation evidence. Don't tell it the intended answer or that the change is correct.
- Spell out in its prompt: never run user-provided code, run only one to three targeted test files and never the full suite, never write generated fixtures, and never start background load processes.
- Ask for actionable findings first and an explicit `NO FINDINGS` verdict when clean.
- Handle findings as "Review Findings" below, rerun the affected tests, and send the revised change to a fresh reviewer. Repeat until a review is clean.

## 3. Draft PR and Issue Reply

1. Commit and push as `references/rules.md` describes, and open a draft PR against `main`. For stacked PRs, use `gh stack`.
2. Start watching the PR's checks right away, with a PR-watching tool if you have one, otherwise `gh pr checks`. Don't end a turn with CI running and nothing watching it.
3. Reply on the issue: the root cause, a workaround the reporter can use now, and the PR link. Reply only to people active now, not to weeks-old comments. Skip the reply for a private or security report.

## 4. Make CI Green

1. Watch the required checks on the exact current head. A queued or in-progress check is not green.
2. Read the logs of each failure and separate code failures from infrastructure flakes. Fix code failures at their root and push.
3. Rerun failed jobs without code changes only when the evidence shows a flake (`gh run rerun <id> --failed`, on the newest run for the head). For Next.js deploy-suite tests, decide flakiness from the last ~25 full runs' `deploy-suite-report` artifacts, never a dispatched rerun.
4. If the e2e suites pass in CI on the head, failures seen only locally are local noise.
5. Check `gh pr view --json mergeable` after each push. A conflicting PR gets no CI runs: rebase it.

## 5. Big Bonk Loop

1. After each meaningful push, once local targeted tests and `vp check` pass, post a PR comment with exactly:

   ```
   /bigbonk review for issues
   Please review exact head `<sha>` without modifying or pushing the branch. Report all actionable findings within your 8-minute time limit.
   ```

   Take `<sha>` from `git rev-parse HEAD` right after pushing, not from `gh pr view`, which lags. Never tell Bonk what changed, what to focus on or which findings to confirm. For transform or analysis PRs prone to edge-case churn, you may add that it should only flag issues affecting real-world usage. Never use `/bonk`, only `/bigbonk`.

2. Before triggering, check `gh run list --workflow bigbonk.yml` for a run in progress. If one is, wait for its review first.
3. Watch CI in parallel. If CI goes red, fix it before the next round.
4. Watch for the first new ask-bonk comment or new PR review posted after the trigger, and address it the moment it lands. Don't re-trigger a silent run before 10 minutes. If a run's log goes quiet for several minutes, cancel it and re-trigger. A posted verdict wins over a later "cancelled" notice.
5. Handle every finding as "Review Findings" below. Reply to each declined finding in the next trigger comment, then re-trigger on the new head right away. A decline doesn't end the loop.
6. Continue until the latest review on the latest head approves or reports no actionable findings. There is no round cap while findings stay in scope.
7. After a stack rebase, re-trigger only PRs whose own diff changed (compare `git patch-id --stable`). A rebased PR with an identical diff keeps its LGTM.
8. If Bonk pushes whitespace-only `pnpm-lock.yaml` commits, revert them. On a fork PR whose lockfile differs from main, merge main into the branch before re-triggering.

If a contributor pushes to the branch mid-review, don't adopt their change because it looks equivalent. Keep your own commits as the source of truth, audit theirs from scratch, and let the user decide.

## 6. Review Findings

Handle sub-agent, Bonk and clanky findings as "Review Findings" in `references/rules.md` says. Reply to findings on the PR, batched into the next trigger comment, and raise out-of-scope findings and scope creep with the user.

## 7. Mark Ready

Mark the draft ready with `gh pr ready <n>` once all of these hold:

- the reported bug has a faithful regression test that failed before the fix;
- focused local validation passes;
- the latest independent review has no actionable findings;
- the CI workflow's checks on the latest head are green (fix Deploy Examples failures too; don't hold the PR in draft for one pending slow check once everything else is green and Bonk approved);
- the latest Big Bonk review on the latest head has no actionable findings.

clanky reviews a PR only once it is ready. Read its full review and inline comments (`gh api repos/cloudflare/vinext/pulls/<n>/reviews` and `/comments`), including INFO findings and "approved with comments", and handle them as "Review Findings". Once they are handled, comment `clanky review` to request a fresh review, and treat that as another round.

## 8. Report

Report the issue, branch, PR URL, root cause, regression test, local validation, CI state, the review and Bonk verdicts, clanky's findings, and every declined finding with its reason.

If blocked by permissions, missing secrets, an outage or an unreproducible report, leave the PR in draft and state the exact blocker and the next action needed.
