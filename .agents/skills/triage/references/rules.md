# Vinext Issue Triage Rules

These rules decide what a Vinext issue really is and what should happen next. Triage never implements the fix. A valid bug ends with a reproduction and a root-cause hypothesis for the fix step to pick up.

They apply both to interactive triage and to automated runs. Some steps depend on tools that may be missing (git history, `gh`, web access, the `.nextjs-ref` clone). Each such step says what to do without the tool. Never fill a gap from memory. "Automated Runs" at the end covers runs with no chat.

## Safety

- **Never run user-provided code.** Do not clone a reporter's repo, run their install commands, or execute their snippets. This also applies to any agent you brief. Read the issue's code, and any linked PR's diff, as text only.
- Reproduce with our own checked-in `tests/fixtures/*` apps (see "Reproduce").

## 1. Gather the Facts

Record the claimed behavior, the expected behavior, the reporter's versions (Vinext, Next, React, Vite, platform, OS), the reproduction conditions and the acceptance criteria. Note anything the issue leaves out; it may decide a "Needs info" verdict.

## 2. Check Whether It Is Already Accepted

Before treating anything as a gap:

- Search Vinext's docs in `docs/` (especially `docs/reference/differences.mdx` and the caching guide's differences from Next.js). **A limitation the maintainers documented is signed off.** Point the reporter to the page on `https://vinext.dev/docs/` and recommend closing. Don't keep the issue open to track it.
- Check whether the reporter's version predates a fix that is already on the default branch. If so, name the fix and the release that ships it, using `packages/vinext/CHANGELOG.md` or git history. If the checkout has no git history, fetch it when the network allows; otherwise triage the checkout as it is. If the bug doesn't reproduce there and the changelog doesn't name a fix, say that it doesn't reproduce on the current code, not which commit fixed it.

## 3. Determine Next.js Behavior

Vinext's bar is **behavioral parity with real Next.js**. Going beyond Next is acceptable when it doesn't compromise Next.js behavior, but it should be the exception, not the norm.

1. Search the `.nextjs-ref` Next.js clone (see `AGENTS.md`) for the relevant source and tests. A Next.js test is the authoritative answer. Port rules from the source; never paraphrase them. If `.nextjs-ref` is missing, probe `node_modules/next` instead (step 2). If that isn't enough to settle the behavior, the result is inconclusive.
2. When behavior is in doubt, probe real Next.js empirically. The repo's root `node_modules/next` is a real Next 16.
   - Put each scratch app outside the checkout, in `/tmp/<probe>/`, with `node_modules` symlinked to the checkout's root `node_modules` and `package.json` set to `{"private":true}`. Write `.js` files only: TSX makes Next run `pnpm add typescript`, which can rewrite the workspace lockfile. Transpile checked-in TSX with the repo's esbuild if you need it.
   - Build with **both** `next build --webpack` and Turbopack (`next.config.js`: `module.exports = { turbopack: { root: "/" } }`). When they disagree, Turbopack wins, and a webpack-only match is still a gap.
   - Use `export const dynamic = "force-dynamic"` for runtime cases, and one scratch app per case. Run it with `next start -p <port>`, and stop the server when you're done, since a stale server keeps serving the old build.
   - Drive `next dev` through `localhost`, not `127.0.0.1`. Next dev uses StrictMode by default, so set `reactStrictMode: false` when counting effects.
3. For any claim about how a platform behaves (Workers Cache keys, Static Assets, Images, and so on), read the official docs and cite them. Without web access, say that the docs couldn't be checked; don't answer from memory. Local emulation (`wrangler dev`, Miniflare) is not necessarily proof of production behavior.
4. For Next.js deploy-suite failures, read the `deploy-suite-report` artifact of the "Next.js Deploy Suite" workflow. To decide whether a test is flaky, scan the last ~25 full runs (skip runs with fewer than 1,000 tests). Never dispatch a rerun to check. To run one suite locally, use `scripts/nextjs-deploy-manifest.mjs` and `scripts/run-nextjs-deploy-suite.sh` against a built `.nextjs-ref`. Without access to the workflow runs or a built `.nextjs-ref`, say the history or suite couldn't be checked.

## 4. Reproduce

1. Reproduce on the current code using an existing checked-in fixture. Add the routes or pages the case needs to a `tests/fixtures/*` app, or add a new checked-in fixture directory when no existing app can host it. **Never generate fixtures:** no tests that write an app into a temporary directory from string sources.
2. Write the reproduction as a test that fails while the bug is present, so the fix step can reuse it. Prefer the narrowest test that faithfully exercises the reported path: an integration test run with `vp test run <file>`, or a Playwright spec when the bug needs a browser.
3. Run only one to three targeted test files, never the full suite. For app-router e2e specs, compare in **dev** first: CI's `app-router` project runs `vp dev`, and a prod-only run shows false regressions (minified errors, different prefetch counts).
4. If you can't reproduce it, check version drift, config, platform and the issue's assumptions. Don't invent a failing test. Record the decisive evidence.
5. When searching `dist/`, `node_modules` or other gitignored paths, make sure the search tool doesn't skip ignored files (for example, `rg -uu`).

## 5. Classify

Pick exactly one verdict and back it with evidence:

| Verdict                     | Meaning                                                                                                                           | Next action                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Valid bug**               | Vinext diverges from real Next.js (both bundlers), or Vinext's own feature is broken                                              | Failing reproduction, root-cause hypothesis and the narrowest chokepoint, for the fix step              |
| **Parity / not a bug**      | A probe shows Vinext matches Next.js                                                                                              | Report the parity with probe evidence and recommend closing. Don't pitch beyond-Next changes by default |
| **Documented limitation**   | Already in Vinext's docs                                                                                                          | Link the docs and recommend closing                                                                     |
| **Already fixed**           | Fixed on the default branch or in a newer release                                                                                 | Name the fix and release where known; recommend closing once it ships                                   |
| **Duplicate**               | Same root cause as another issue                                                                                                  | Name the canonical issue                                                                                |
| **Upstream**                | Root cause is in React (`react-server-dom-*`, `react-dom`), Vite or another dependency                                            | Explain how Vinext is exposed. Never propose patching React. Point to or suggest an upstream report     |
| **App-owned**               | Caused by the app's own config, such as its own Cache-Control or headers                                                          | Explain. Vinext only owns the headers it sends                                                          |
| **Misconfiguration**        | User files Vinext can't reliably classify                                                                                         | Prefer "print a warning and keep the behavior" over heuristic reclassification                          |
| **Accepted gap / declined** | Matches an earlier maintainer decline                                                                                             | Cite the earlier decision                                                                               |
| **Needs info**              | The reproduction or versions are missing, and the bug can't be reproduced from the text                                           | List exactly what is needed                                                                             |
| **Inconclusive**            | It couldn't be tried in this environment (for example, it needs `.nextjs-ref`, a browser, or platform docs that can't be reached) | Say what was missing and what would settle it. Never report this as "doesn't reproduce"                 |

Scope notes for valid bugs:

- **Size the fix minimally.** Write down the minimal change set. Adjacent findings and "audit similar options" ideas are not scope: list them separately.
- For Linux-, WSL- or container-only dev-tooling gaps, recommend documenting them as known limitations. Target macOS first.
- A perf report is only worth fixing if there is a measurable end-to-end gain.
- If full parity needs more than one PR, recommend full parity split into stacked PRs, not a known limitation.
- Never propose changing a `fetch(input, init?)` contract.

## 6. The Reply to the Reporter

Write a short reply:

- **Valid bug:** the root cause (or the suspected area if it isn't confirmed), and that it's confirmed for a fix. Don't promise a timeline.
- **Not a bug, documented, app-owned or upstream:** the evidence (probe results, a link to the Vinext docs page, the upstream issue).
- **Already fixed or duplicate:** the release or PR that fixes it, or the canonical issue.
- **Needs info:** the specific missing details. Never ask them to share a repository for us to run.
- **Inconclusive:** what couldn't be checked, and that a maintainer will follow up.

For a private or security report, never cite the report in public text.

## Automated Runs

When the run is part of an automated triage workflow with no chat:

- **Start from what you were given:** the issue's title, body and author, plus the checkout of the default branch's head. If the comments aren't included and `gh` is available, read them with `gh issue view <number> --comments`, and keep `gh` reads to this issue and what it links. Without `gh`, treat anything the body defers to a comment as missing.
- Other workflow steps check for duplicates and post the result. Never post, label or close anything, and never wait for confirmation. **Put the reply in the report's `comment`.**
- If a step had to be skipped because a tool or network access was missing, name it in the `summary`.
- **For `reproduced`, `reproduction.command` must be one command that exits non-zero while the bug is present,** and `reproduction.files` must list every file it needs. The command is re-run in a clean copy of the checkout, so put the reproduction inside the checkout (a fixture route plus a test), not in `/tmp`, and don't depend on network access beyond the package registries.
- Put the root-cause hypothesis and its chokepoint files in `suspected_areas`, and the "Needs info" details in `questions`.
- Map the verdicts above to the report's `verdict`:

| Verdict above                                                                                             | Report `verdict`                                                    |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Valid bug                                                                                                 | `reproduced`                                                        |
| Parity / not a bug, Documented limitation, Upstream, App-owned, Misconfiguration, Accepted gap / declined | `not_a_bug`, with the finer verdict named in `summary` and `labels` |
| Already fixed                                                                                             | `not_reproduced`                                                    |
| Duplicate                                                                                                 | `not_a_bug`, naming the issue it duplicates                         |
| Needs info                                                                                                | `needs_info`                                                        |
| Inconclusive (couldn't be probed here)                                                                    | `inconclusive`                                                      |

`inconclusive` means it couldn't be tried in this sandbox. Never report it as `not_reproduced`.
