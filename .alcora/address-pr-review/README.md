# Address PR review

vinext's own copy of Alcora's **Review fixes** (`alcora/review-fixes`), which
it replaces: its reviewers are vinext's, BigBonk and Clanky, and it asks
BigBonk for each head's review itself (below), as Fix triaged issues no longer
does. Alcora takes it
from this repository as a registry source (**Settings → Registry sources**:
`https://github.com/cloudflare/vinext`, folder `.alcora`), and a workflow
installed from `alcora/review-fixes` offers to move to it on its page,
keeping its runs and history. Raise `version` in `alcora.json` to release a
change.

Takes a fix's draft pull request, such as one **Fix triaged issues** opened,
to the point where a maintainer only has to review it. Every review or comment
on it, and its checks finishing, is a round in the sandbox that wrote the fix.
The issue keeps its **fix: in progress** label while rounds go on, until the
fix is ready, when **fix: ready** takes its place, or stalls. A fix that goes
back in review is **fix: in progress** again.

Its triggers take the tracked pull requests of every workflow by default:
those a sandbox step opened and kept its sandbox for. **Pull requests opened
by** on each picks the workflows whose pull requests they take, such as Fix
triaged issues alone.

## Asking BigBonk

**BigBonk not asked about the head?** BigBonk only reviews when asked. When
the checks pass on a head none of the workflow's BigBonk steps has asked about
since it moved, and the fix hasn't stalled, **Ask BigBonk** asks it
(`/bigbonk review for issues`) for that exact head. That is how a new fix gets
its first review, and a head someone else pushed gets one too. A fix whose
checks fail is fixed first (below), and BigBonk is asked about the push.

Clanky isn't asked here: it reviews a push by itself, or says it waits to be
asked, and is asked then (below).

## An assigned issue

Assigning the issue hands the fix to a person. Each of the three triggers
lets a round through only while the issue has no assignee, as it is when the
round starts: **Nobody assigned?** after a review or comment, and the same
condition in **On the head, nobody assigned?** after checks and **Still in
review, nobody assigned?** after BigBonk says nothing. A round on an assigned
issue does nothing, and BigBonk is neither asked nor asked again. Unassigning
the issue lets the next round go on. It needs an Alcora that gives
`trigger.issue.assignees`.

## When BigBonk says nothing

**BigBonk didn't answer** (a No reply trigger) starts a round when BigBonk
has posted nothing on the pull request for 15 minutes since the workflow last
asked it, by any of its **Ask BigBonk** steps or **Ask BigBonk again**. BigBonk
can go quiet without a word: a run that times out edits the comment it posted
when it last timed out, rather than posting another, and a run that never
starts, or is cancelled, says nothing at all. No GitHub event comes of either,
so Alcora looks for the silence itself, every five minutes, from what it
recorded of the pull request. Each ask starts one round at most, and none
starts while another round of the workflow is queued or running for the pull
request.

**Still unanswered?** BigBonk may have answered while the round waited for
the one ahead, and **Still in review, nobody assigned?** leaves a fix alone
once it is ready, stalled or assigned. Then BigBonk is asked again, as when it
says it timed out, within the same cap of 2 times since the head last moved
(**Asked again fewer than 2 times?**). After that, the fix stalls.

## A review or a comment

Each review or comment on the pull request starts a round, one at a time for
the pull request, and every step of it is in the graph:

1. **Who posted it** looks the author up, and **Reviewer?** lets through
   BigBonk (`ask-bonk[bot]`), Clanky (`clanky-the-clanker[bot]`) and anyone
   who may write to the repository. Anyone else's comment does nothing.
2. **Approved, nothing to address?** A GitHub approval that says nothing
   else is an approval. Anything with text or inline comments, an approval's
   included, goes to **What did they say?**, which sorts it: an approval,
   findings (questions included), or not a review at all.
3. **An approval.** **Record approval** records that the author approved the
   commit they reviewed. **Check review state** then tests the approvals of
   the head as it is now: by default anyone's is enough; list reviewers in
   **Who has to approve it** to need each of them. Once it holds and **Checks
   pass?** too, the pull request is **Ready for review**, the fix is **Fix
   ready**, the issue gets one comment saying a fix is ready, and **Label it
   ready** labels it **fix: ready**. Until then, **Awaiting approval** notes
   who is missing.
4. **Findings.** **Address it** continues the sandbox and agent that wrote the
   fix. The review may be of an earlier commit than the head (rounds queue),
   so the agent is told both, and answers what still applies. Its answers go
   in the review's threads (**Reply in threads**). If it left an inline
   comment without an answer, **Answer the rest** asks it for just those,
   without pushing; left again, the fix stalls. Then the fix is **Back in
   review**, and the reviewer is asked again. Each reviewer's answer goes to
   that reviewer alone:
   - **BigBonk's review?** BigBonk is asked again, with the agent's answer in
     the same comment.
   - **Ask BigBonk about the push?** Anyone else's round that pushed has
     BigBonk review the new head. **Anything to answer?** posts the agent's
     answer to the reviewer first (**Answer them**), then the `/bigbonk`
     comment, on its own.
   - **Ask Clanky?** Each push gets Clanky's review, or its word that it
     waits to be asked (below), so it is asked (`clanky review`, with the
     answer) only when nothing was pushed.
   - **Ask them again?** A person gets a GitHub review request (**Request a
     review**), and the agent's answer as a comment when nothing was pushed.
5. **Not a review.**
   - **BigBonk timed out?** BigBonk is asked again for the head.
   - **BigBonk cancelled?** A later comment replaced BigBonk's request.
     **Asked BigBonk since?** When the workflow's latest comment asked BigBonk,
     that newer request is the one running, and nothing is done; otherwise
     BigBonk is asked again.
   - **Clanky waits to be asked?** Clanky doesn't review a bot's pull request
     by itself, and says to comment `clanky review`: the workflow does.
   - Each is asked again at most 2 times since the head last moved
     (`trigger.pull_request.posted.<step id>` of **Ask BigBonk again** and
     **Ask Clanky again**), BigBonk's counting the times it said nothing
     (above); after that, the fix stalls.
   - Anything else from a bot, such as an error or a missing permission ("User
     … does not have write permissions"), stalls the fix for a person to see
     why. A person's comment that isn't a review, such as thanks, does
     nothing: nothing ever waits on a person.

Each inline comment gets its answer in its own thread: the agent says what it
did about it, and whether to resolve the thread. It resolves the ones it
fixed, and leaves open the ones it declined or put off, for the reviewer to
weigh. The replies go before the next request for a review, since a later
comment would replace a BigBonk request that is still waiting. Findings in a
review's own text are answered in a comment to the reviewer, before BigBonk
is asked.

## Checks

Checks finishing on the head start a round too. When they failed, **Address
it** works on them as on a review, and BigBonk is asked to review what it
pushed. When the agent finds every failure was a flake or the
infrastructure's, it pushes nothing, and **Re-run them** re-runs the failed
jobs of the GitHub Actions workflows that failed, each at most twice; when
they finish, the checks start the next round as before. That needs the App's
**Actions: read and write** permission. When they passed, **Check review
state** decides as it does after an approval.

An approval is only ever for the commit it was given on. After anyone pushes,
the earlier approvals no longer count, and a fix that was ready goes back to
in review. Clanky reviews the push, by itself or when it says to ask it;
BigBonk is asked once the checks pass on it (above).

A round that needs a person, failed checks the agent finds nothing to change
for, flaky checks that have been re-run twice already, or 30 rounds without
settling leave the issue **Fix stalled** too. When the agent stops to ask the
maintainers questions, the issue shows **Needs an answer** until a member
answers on its triage page.

Between rounds the sandbox is saved and stopped, so nothing runs while it
waits.

Installs `alcora/issue-fix`, `alcora/github-user` and `alcora/classify`. Set
**Guidance** to the project's rules for fixing, as for Fix triaged issues, such
as `.agents/skills/fix/references/rules.md`.

## What it expects of the reviewers

- Who may review is **Reviewer?**: change it to take other bots, or only some
  people. Who has to approve is **Who has to approve it**.
- BigBonk's workflow has to run for a comment from the project's Alcora App.
  One that skips comments from bots, or from authors who are not members,
  never starts, and one that answers that the App may not ask stalls the fix.
- Clanky reviews a pull request on each push, or, for one a bot opened, says
  to comment `clanky review`, which the workflow does.
- A project without checks on its pull requests never has them pass, so
  BigBonk is only asked after a review, and its pull requests stay drafts.
