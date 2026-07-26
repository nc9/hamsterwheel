# Adoption checklist

Work this before the first `--execute` in a new repo. Items marked **SILENT** fail without an error message: the loop keeps running and quietly does the wrong thing.

## 1. Land the loop infrastructure on the base branch first — **SILENT**

hamsterwheel creates each issue's worktree from `origin/<base_branch>`, **not** from your current branch. Only `hamsterwheel.toml` is read from cwd. Anything else the loop needs — an install script, a CI workflow, the contract block in CLAUDE.md — must be merged to the base branch or every session runs without it.

Verify against the remote, not the working tree:

```bash
git show origin/main:package.json | grep loop:install
```

Observed: a first run claimed an issue, built the worktree, and died on `install_cmd "bun run loop:install" failed: Script not found`, because the script existed only on the unpushed config branch.

## 2. Prove the blocking-review arm actually fires — **SILENT, and it defeats the gate**

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

hamsterwheel closes this with `reviewObserved`: the gate requires a review comment whose timestamp postdates the head commit, and blocks as `needs-decision` when there isn't one. Two failures collapse into it, and both would otherwise read as approval:

- **no review at all** (skipped, errored, workflow disabled, wrong `review.bot` login)
- **a stale review** — the gate reads the _last_ bot comment regardless of age, so after a fix push, a review of the previous commit would otherwise stand in for a review of the code being merged

If you build your own gate, take the principle rather than the code: **absence of a signal is not approval.** Require positive evidence that the check you depend on actually ran against the artifact you are about to ship.

## 3. Check the criteria heading matches, literally — **SILENT**

```bash
hamsterwheel plan   # every skipped issue prints its reason
```

Both an `## Acceptance Criteria` heading and at least one `- [ ]` checkbox are required. A heading with prose under it is not a rubric. Bulk-filed issues from a template are the usual offender: the checkboxes are there, under a differently-named heading.

## 4. Confirm no issue's diff lands in a submodule — **SILENT**

The loop's worktree is one repo. An issue whose fix belongs in a submodule needs a commit and PR in that repo **plus** a gitlink bump in the parent, and one merge gate cannot land both atomically — the parent PR's gitlink would point at a commit not yet on the submodule's remote.

Grep candidate issues for the submodule path before promoting them to Ready. The fix is a second config whose `repo` is the submodule's repo, run from a standalone clone of it, with the gitlink bumped as a separate batched commit afterwards. That is the normal submodule workflow, not a workaround: the pointer bump was never part of the change.

## 5. Set `ci_timeout_ms` from measured durations

Measure, don't guess:

```bash
gh api "repos/OWNER/REPO/actions/runs?event=pull_request&status=success&per_page=40" \
  --jq '.workflow_runs[] | select(.name=="CI") |
        "\(((.updated_at|fromdate)-(.run_started_at|fromdate))/60|floor)m"' | sort -n | uniq -c
```

Include the review workflow if it reports as a check — the gate waits on the whole rollup. Too high is not free: the loop is serial, so every minute waiting on a PR that will never go green is a minute the next issue doesn't start.

One sampling trap: a run list filtered only by workflow name can include runs where path filters skipped the real matrix, making CI look faster than it is. Sanity check against a run you know exercised everything.

## 6. Know what `install_cmd` can't do

It is argv-split and **not** run through a shell. `a && b`, pipes, globs and `$VAR` do not work. Anything compound ships as a script in the repo (`bun run loop:install`) — which also means item 1 applies to it.

## 7. Bake unattended consent into the argv

A harness tool allow-list does not cover a runner's own consent model. Codex needs `approval_policy="never"` plus an explicit sandbox mode; opencode needs `--auto`. hamsterwheel bakes these into the argv it builds. If you wrap or replace that, carry them over — a missing one stalls overnight on an invisible prompt.

## 8. Decide the sandbox posture

`--sandbox` is the only real isolation boundary. Tool allow-lists, env scrubs and fenced prompts are defense-in-depth: `Edit`/`Write` reach absolute paths, scoped `Bash` still runs arbitrary code, and on-disk credentials stay readable.

If you run without it, you are trusting the issue text. Screening plus fencing is good, and it is not a sandbox.

## 9. First batch: `--pr-only`

Identical pipeline, stops at the open PR. Inspect real output before the merge path runs unsupervised. Graduate once you have seen the reviewer emit a correctly-tagged blocking finding at least once — until then item 2 is verified only in principle.
