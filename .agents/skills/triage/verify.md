# Verify

Verify whether a GitHub issue describes an actual vinext bug or a misunderstanding of intended behavior.

**CRITICAL: You MUST always read `report.md` and append to `report.md` before finishing, regardless of outcome. Even if you cannot reach a conclusion — always update `report.md` with your findings. The orchestrator and downstream skills depend on this file to determine what happened.**

**SCOPE: Your job is verification only. Finish your work once you've completed this workflow. Do NOT go further than this (no fixing of the issue, etc.). Do not spawn tasks/sub-agents.**

## Prerequisites

- **`triageDir`** — Directory containing the reproduction project (e.g. `triage/gh-123`). If not passed as an arg, infer from previous conversation.
- **`issueDetails`** — The GitHub API issue details payload. If not available, run `gh issue view ${issue_number}`.
- **`report.md`** — File in `triageDir` written by the earlier skills. Contains the full context.

## Overview

1. Review the issue and any existing reproduction findings
2. Identify the claim: what does the reporter say _should_ happen?
3. Research whether the current behavior is intentional
4. Assess the verdict: bug, intended behavior, or unclear
5. Assign confidence
6. Append verification findings to `report.md`

## Step 1: Identify the Claim

Read the issue (from `report.md` or directly from GitHub) and extract two things:

- **Current behavior**: What the reporter observes happening.
- **Expected behavior**: What the reporter says _should_ happen instead.

The expected behavior is the claim you are verifying.

## Step 2: Research Intended Behavior

**vinext's spec is Next.js.** vinext reimplements the Next.js API surface; where behavior differs from Next.js, that divergence needs an explicit, documented reason to be intended. Use multiple sources, and **do not assume the reporter is correct** — but also do not assume vinext is correct: the whole point of this project is that Next.js behavior is the target.

### 2a: Check the Next.js test suite (strongest evidence)

The local Next.js clone at `.nextjs-ref/` (gitignored) contains upstream's test suite. If it doesn't exist:

```bash
git clone --depth 1 --single-branch --branch canary https://github.com/vercel/next.js.git .nextjs-ref
```

Search it for the reported behavior:

```bash
grep -rn "<keywords>" .nextjs-ref/test/e2e/ .nextjs-ref/test/unit/ -l | head -20
```

A Next.js test that asserts the behavior the reporter expects is authoritative: it is what vinext must reproduce. A test asserting the opposite is equally authoritative. When you find one, note the file path and what it asserts in `report.md`.

### 2b: Check the Next.js source and docs

Read the upstream implementation in `.nextjs-ref/packages/next/src/` and the relevant docs. How does Next.js handle this exact case?

### 2c: Check vinext for intent signals

Look at the relevant source code in `packages/`. Pay close attention to:

- **Comments explaining "why"** — a developer comment explaining why the code works a certain way is strong evidence of intentional design. Treat these comments as authoritative unless they are clearly outdated.
- **Explicit conditionals and early returns** — code that explicitly checks for the reported scenario and handles it differently than the reporter expects is likely intentional.
- **Documented deliberate divergences** — the repo's `AGENTS.md` and PR history record known parity gaps (for example: config `headers` run at a different point in the request order than Next.js). A documented gap is a known limitation, not a bug; note the reference.

### 2d: Git blame on key lines

If `report.md` identifies specific files and line numbers, run `git blame` on the relevant lines to find the commit that introduced the behavior. Then read the full commit message with `git show --no-patch <commit>` and review the associated PR if referenced (`gh pr view <number>`). A commit message, PR description, or PR comment explaining the rationale is strong evidence of intentional design.

### 2e: Search prior GitHub issues and PRs

Search both vinext and Next.js for prior discussion of the same behavior:

```bash
gh search issues "<keywords>" --repo cloudflare/vinext
gh search prs "<keywords>" --repo cloudflare/vinext
gh search issues "<keywords>" --repo vercel/next.js
gh issue view <number> --comments
```

A closed Next.js issue where a maintainer explained why the behavior is intentional is strong evidence of intended behavior. A closed vinext issue where the divergence was discussed and accepted is too.

### 2f: Distinguish bugs from non-bugs

For triage purposes, the definitions are:

- A **bug** is when vinext behaves differently from Next.js **without a documented reason** — an unimplemented edge case, a regression, an accidental divergence. The developer did not know about or did not choose this behavior.
- A **non-bug** (intended behavior) is when the divergence is **documented and deliberate** — a known parity gap recorded in `AGENTS.md` or a PR/issue, or behavior that matches Next.js exactly while the reporter expected something else. Even if the reporter's complaint is legitimate, that is an enhancement request, not a bug fix.

The key question is not "do we _like_ this behavior?" but "did we **choose** it?" If the answer is yes — documented divergence or exact Next.js parity — it is not a bug.

**Common mistakes to avoid:**

- Do not treat a documented parity gap as a bug just because it is inconvenient. It may be worth closing the gap, but that is an enhancement.
- Do not treat a design trade-off as a bug because the reporter frames it as one.
- Do not infer vinext's intent from what would be "reasonable" — infer it from Next.js's actual behavior and vinext's documented decisions.
- If Next.js itself has no defined behavior for the case (both undefined), the verdict is likely `unclear`, not `bug`.

## Step 3: Assess the Verdict

Based on your research, assign one of three verdicts:

### Verdict: Bug

vinext's behavior diverges from Next.js without a documented reason, or contradicts vinext's own documented behavior. Evidence:

- A Next.js test asserts different behavior than we produce
- The behavior contradicts what our shims/docs promise
- The behavior is clearly a regression (worked before, broke after a change)
- No guard, comment, or documented decision accounts for the divergence

### Verdict: Intended Behavior / Enhancement Request

The developer was aware of the behavior and chose it. Evidence:

- The exact Next.js behavior matches vinext's current behavior (the reporter expected something Next.js doesn't do)
- The divergence is a documented parity gap or deliberate decision (AGENTS.md, PR, issue)
- A code comment explains the limitation or trade-off
- A prior issue on this exact behavior was closed as "by design"

Note: This verdict does not mean the reporter's concern is invalid. It may still be worth improving — but as a parity/enhancement item, not a bug fix.

### Verdict: Unclear

You cannot confidently determine intent. This might happen when:

- Next.js has no test or doc covering the case
- The behavior could be either intentional or accidental
- vinext and Next.js both behave the same way and the reporter's expectation is simply undocumented

When unclear, lean toward "unclear" rather than guessing.

## Step 4: Assign Confidence

Rate your confidence:

- **high** — Strong evidence (a Next.js test, explicit docs, a documented vinext decision, unambiguous code)
- **medium** — Reasonable evidence but some ambiguity remains
- **low** — Mostly inference; could go either way

## Step 5: Write Output

Append your verification findings to `report.md`.

Include a new section with:

- The reporter's claim (expected behavior)
- Your verdict: `bug`, `intended-behavior`, or `unclear`
- Your confidence: `high`, `medium`, or `low`
- Evidence supporting your verdict (specific Next.js test files + what they assert, doc references, commit messages, prior issues/PRs, code comments)
- If the verdict is `intended-behavior`: explain the design rationale and note that the reporter's concern could be reframed as a parity/enhancement request
- If the verdict is `bug`: explain the Next.js behavior we must match and cite where it is specified (test file, source, or docs)
- If the verdict is `unclear`: explain what evidence is missing and what would resolve the ambiguity
