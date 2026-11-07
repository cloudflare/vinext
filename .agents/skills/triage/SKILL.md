---
name: triage
description: Opt-in workflow for triaging one GitHub issue without fixing it. Invoked only via `/triage <github-issue-url>` (`$triage` in Codex). Establishes live state, reproduces with our own fixtures, probes real Next.js for parity, classifies the issue, and drafts the issue reply and next action. Hands valid bugs off to the fix step.
argument-hint: <github-issue-url>
disable-model-invocation: true
metadata:
  # Maintainer-only: keeps `npx skills add cloudflare/vinext` from offering it.
  internal: true
---

# Triage GitHub Issue

Issue: $ARGUMENTS

Establish the issue's live state below, then follow [`references/rules.md`](references/rules.md) for everything else: safety, the parity check, reproducing, the verdict and the reply. Its "Automated Runs" section doesn't apply here. In those rules, "the fix step" means fixing the bug through the "Fixing Bugs" workflow in `AGENTS.md`, or through your own fix skill if you have one.

Do not open a PR, post a comment, change labels or close the issue without confirmation.

Claude Code loads this skill through the `.claude/skills/triage` symlink. On Windows, Git checks that symlink out as a plain text file unless symlinks are enabled (Developer Mode plus `core.symlinks=true`).

## Input

Require one GitHub issue URL, passed as the `/triage` argument. If it is missing, ask for it. If it names a repository other than the current checkout, find an existing checkout of that repository before reading code.

## Hard Rules

- **Triage against current main.** Run `git fetch origin main` and compare it with the checkout's HEAD. A stale checkout produces "already fixed" mistakes.
- **Protect the GitHub API budget.** Every session and automation on the account shares the quota. Read one issue with plain `gh issue view --comments`. Before any multi-issue sweep, run `gh api rate_limit`, estimate the cost, keep `first:` small, prefer REST or `gh search`, and stop when fewer than ~1,500 calls remain.
- **No PR comments on PRs with an in-flight Bonk run.** Any issue comment cancels it.

## 1. Establish Live State

1. Parse the URL into owner, repository and issue number.
2. Read the issue, every comment, linked PRs and cross-references with `gh`.
3. Look for an existing branch, open PR or merged fix (`gh pr list --search "<number>"`, `git log origin/main --grep`). If a PR exists, check its state with `gh pr view <n> --json state` before suggesting any follow-up on it.
4. Look for duplicates and earlier decisions: search open and closed issues and PRs for the same symptom, including ones where maintainers already made a parity or decline call.

Then work through `references/rules.md`.

## 2. Report and Confirm

Report to the user:

- the verdict, with its evidence (file:line, probe output, docs, earlier decision);
- the main SHA you triaged against;
- the reproduction status;
- for valid bugs: the root-cause hypothesis, the minimal change set, the suggested fixture and test, and the hand-off to the fix step;
- the draft reply, and the proposed labels or state change.

Post the comment, change labels or close the issue only after the user confirms.
