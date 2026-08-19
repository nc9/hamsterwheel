# Adoption checklist

Work this before the first `--execute` in a new repo. Items marked **SILENT** fail without an error message: the loop keeps running and quietly does the wrong thing.

## 1. Land the loop infrastructure on the base branch first — **SILENT**

hamsterwheel creates each issue's worktree from `origin/<base_branch>`, **not** from your current branch. Only `hamsterwheel.toml` is read from cwd. Anything else the loop needs — an install script, a CI workflow, the contract block in CLAUDE.md — must be merged to the base branch or every session runs without it.

Verify against the remote, not the working tree:

```bash
git show origin/main:package.json | grep loop:install
```

Observed: a first run claimed an issue, built the worktree, and died on `scripts.setup "bun run loop:install" failed: Script not found`, because the script existed only on the unpushed config branch.

## 2. Prove the blocking-review arm actually fires — **SILENT, and it defeats the gate**

Skip this only if you run `review.mode = "off"`. It applies equally under `required` and the default `optional`: the mode decides whether a review must _exist_, never what an existing review is allowed to say.

The gate greps your review bot's comment for severity markers (`(high)`, `(critical)`, `🔴`, `severity: high`). Most review workflows ask for freeform prose and never emit them. Then `blockingReview` is always 0, and a review full of real problems reads as approval.

Test it against a real comment, not a hypothetical one:

```bash
gh api repos/OWNER/REPO/issues/<recent-pr>/comments \
  --jq '.[] | select(.user.login=="claude[bot]") | .body' > /tmp/rev.txt

# does the configured regex match anything in it?
grep -icE '\((high|critical)\)|🔴|\[(critical|high)\]|severity:\s*(high|critical)' /tmp/rev.txt
```

If that returns 0 on a review that clearly contained serious findings, the arm is dead. **Fix the reviewer, not the regex.** Broadening the pattern to match prose means trusting freeform LLM text as a machine-readable signal, which is the same mistake that makes rubric graders unreliable. Instead require the format in your review workflow's prompt, and say why in the prompt so the reason survives the next edit:

> Every finding MUST start with a severity tag in parentheses, one of:
> `(critical) (high) (medium) (low) (nit)`. An automated merge gate greps for
> `(high)` and `(critical)`. An untagged finding is invisible to it, so a real
> problem described without a tag will merge anyway.

Watch out for a trap when verifying: a review that _discusses_ the regex will match it. Check that the matches are real findings, not the reviewer quoting the pattern.

## 2b. Know that a skipped review still reports green — **SILENT**

Related, and worse, because the PRs it hits are the ones that most need reviewing.

GitHub's Claude review action refuses to run on any PR whose diff touches a workflow file — the workflow content must match the default branch's copy, a supply-chain protection. When it refuses it **skips, posts nothing, and the check reports SUCCESS**:

```
##[warning]Skipping action due to workflow validation: Workflow validation failed.
Attempt 1 failed: ... Error is not retryable, giving up immediately
```

So a PR editing CI gets a green check, no review comment, and no findings. Under a naive gate that reads as CI green + review clean → merge.

hamsterwheel closes this with `reviewObserved`, **under `review.mode = "required"`**: the gate requires a review comment whose timestamp postdates the head commit, and blocks as `needs-decision` when there isn't one. Two failures collapse into it, and both would otherwise read as approval:

- **no review at all** (skipped, errored, workflow disabled, wrong `review.bot` login)
- **a stale review** — the gate reads the _last_ bot comment regardless of age, so after a fix push, a review of the previous commit would otherwise stand in for a review of the code being merged

Under the default `optional`, that check does not run — by design, because demanding a review from a repo that has no reviewer parks every PR forever. What carries the decision instead is CI plus the rubric grader, a fresh adversarial session that did not write the code. **So this item is a real decision, not a formality**: if your repo does have a review bot and you want its verdict to be load-bearing, set `review.mode = "required"` and then verify item 2 — otherwise a broken reviewer costs you nothing visible, which is precisely the failure this section is about.

If you build your own gate, take the principle rather than the code: **absence of a signal is not approval.** Either require positive evidence that the check you depend on ran against the artifact you are about to ship, or decide deliberately that the check is not load-bearing. What you must not do is treat its silence as a pass.

Independent of mode, a `CHANGES_REQUESTED` review from any login blocks. That is the one review signal a human reliably produces without being told about severity tags, and hamsterwheel reads the review _state_ rather than its prose. `off` does not read it, since it makes no review calls at all.

## 3. Check the criteria heading matches, literally — **SILENT**

```bash
hamster plan   # every skipped issue prints its reason
```

Both an `## Acceptance Criteria` heading and at least one `- [ ]` checkbox are required. A heading with prose under it is not a rubric. Bulk-filed issues from a template are the usual offender: the checkboxes are there, under a differently-named heading.

## 4. Confirm every Ready issue's diff lands in THIS repo — **SILENT**

The loop's worktree is one repo, and so is its board filter: it works issues and opens PRs in
`cfg.repo` only. An issue whose fix belongs in a submodule, a split-out repo or a sibling package
repo is not workable here, however well written it is. A submodule fix additionally needs a gitlink
bump in the parent, and one merge gate cannot land both atomically — the parent PR's pointer would
reference a commit not yet on the other remote.

Grep candidate issues for the other repo's paths before promoting them to Ready. The fix is a second
config whose `repo` is that repo, run from a standalone clone, with the pointer bumped as a separate
batched commit afterwards. That is the normal workflow, not a workaround: the pointer bump was never
part of the change.

Two consequences to settle **before** writing those issues, not after:

- **Every acceptance criterion must be checkable inside that repo.** The rubric grader is read-only
  inside one worktree. A box naming a file in the other repo can never be ticked — the grader looks,
  does not find, and fails the issue. Those belong in a follow-up chore in the repo that owns the
  file.
- **Anything the other repo generates from this one's source goes stale on every merge**, and its CI
  goes red until someone regenerates and re-points it. Decide who does that and when. Batched, once
  per wave, is fine; unowned is not.

## 4b. If the repo enforces DCO, set `commit_signoff` — **SILENT until the first PR**

A DCO check rejects per **commit**, and its failure names the commit, not your config — so it reads
as an agent mistake rather than a missing setting. Set `commit_signoff = true` and the session
prompts instruct `git commit -s`.

The trailer must match the commit's **mailmap-applied** author. If `.mailmap` rewrites the identity
git is configured with, a correctly-signed commit still fails, forever. Set the clone's
`user.email` to whatever the mailmap resolves _to_:

```bash
git -C <clone> config user.email <the-mailmap-target-address>
```

Lane worktrees share the clone's `.git/config`, so setting it once covers every lane.

## 5. Set `ci_timeout_ms` from measured durations

Measure, don't guess:

```bash
gh api "repos/OWNER/REPO/actions/runs?event=pull_request&status=success&per_page=40" \
  --jq '.workflow_runs[] | select(.name=="CI") |
        "\(((.updated_at|fromdate)-(.run_started_at|fromdate))/60|floor)m"' | sort -n | uniq -c
```

Include the review workflow if it reports as a check — the gate waits on the whole rollup. Too high is not free: the loop is serial, so every minute waiting on a PR that will never go green is a minute the next issue doesn't start.

One sampling trap: a run list filtered only by workflow name can include runs where path filters skipped the real matrix, making CI look faster than it is. Sanity check against a run you know exercised everything.

## 5b. Know what your board size costs in GraphQL

Ranking the queue spends a `gh issue view` per **Ready** item plus a sub-issue query per candidate, against a 5,000-point-per-hour GraphQL budget that Projects v2 shares. A 50-item Ready queue costs ~100 points per invocation; promoting 50 issues to Ready costs another 50 mutations.

```bash
gh api rate_limit --jq '.resources | {graphql, core}'
```

`hamster doctor` now reports both pools with a reset countdown, `preflight` refuses to start when GraphQL is too low to finish an issue, and each claim is preceded by a free re-check. The trap this closes: REST `core` stays healthy while `graphql` is empty, so the loop fails at the board read and every `gh issue`/`gh pr` command keeps working — which reads as a misconfigured board rather than a wall that clears itself.

## 6. Know what `[scripts]` `setup` can't do

It is argv-split and **not** run through a shell. `a && b`, pipes, globs and `$VAR` do not work. Anything compound ships as a script in the repo (`./scripts/setup.sh`) — which also means item 1 applies to it. The script does get `HAMSTER_*` context env vars (`HAMSTER_LANE_COLD`, `HAMSTER_WORKSPACE_PATH`, …), so cold/warm branching lives inside the script, not the config.

## 7. Bake unattended consent into the argv

A harness tool allow-list does not cover a runner's own consent model. Codex needs `approval_policy="never"` plus an explicit sandbox mode; opencode needs `--auto`. hamsterwheel bakes these into the argv it builds. If you wrap or replace that, carry them over — a missing one stalls overnight on an invisible prompt.

## 8. Decide the sandbox posture

`--sandbox` is the only real isolation boundary. Tool allow-lists, env scrubs and fenced prompts are defense-in-depth: `Edit`/`Write` reach absolute paths, scoped `Bash` still runs arbitrary code, and on-disk credentials stay readable.

If you run without it, you are trusting the issue text. Screening plus fencing is good, and it is not a sandbox.

## 8b. Provision the board's Status options — **SILENT until the first command**

`init` creates the board, the labels, the `Owner` field and `Blocked reason` with all its options —
but on a freshly created board the `Status` field keeps GitHub's defaults (`Todo`, `In Progress`,
`Done`). `doctor` passes, because it resolves the board fine. The break lands on the first real
command:

```
✗ Error: status option "Draft" not on the board (have: Todo, In Progress, Done)
```

Check before the first run, and add the six the loop uses (`Draft`, `Ready`, `In Progress`,
`In Review`, `Blocked`, `Done`):

```bash
gh project field-list <n> --owner <owner> --format json | jq '.fields[] | select(.name=="Status")'
```

`updateProjectV2Field` with `singleSelectOptions` **replaces the whole option set**, so it is only
safe while the board has no items — which is exactly the post-init window.

## 9. First batch: `--pr-only`

Identical pipeline, stops at the open PR. Inspect real output before the merge path runs unsupervised. Graduate once you have seen the reviewer emit a correctly-tagged blocking finding at least once — until then item 2 is verified only in principle.
