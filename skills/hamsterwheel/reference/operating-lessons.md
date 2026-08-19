# Operating lessons

Paid for by a production loop running overnight waves. Ordered by how expensive each one was to learn.

## Decisions

### If a decision must hold, it cannot live in a prompt

The rubric grader runs read-only and cannot execute tests, so it failed criteria like "typecheck passes" for lack of execution evidence, even when CI had already proven them. A representative verdict marked a criterion unmet with the evidence _"execution blocked in grader env — no concrete pass evidence"_ while conceding in the same breath _"static analysis strongly suggests clean."_

Telling it not to do that in the prompt did not fix it. It reduced the frequency, which is worse than not working, because it looks fixed.

The fix has two layers and the second is the point:

1. Tell the grader what CI already verified and instruct it not to re-judge those criteria.
2. **Also** apply that correction deterministically in code afterwards.

Layer 1 is advisory. Layer 2 makes it true. **Whenever correctness depends on a model following an instruction — as opposed to output quality depending on it — a deterministic backstop is missing.**

### Prose is not a machine-readable signal

Two independent instances of the same mistake:

- Parsing a rubric verdict out of an LLM's prose. Fix: force a schema (`codex --output-schema`), or parse by scanning back from the last `}` with brace matching, since models wrap JSON in commentary.
- Gating merges on severity words in a review comment when nothing ever asked the reviewer to emit them. Fix: require the format from the reviewer.

Both times the tempting fix was a cleverer parser. Both times the right fix was to make the producer emit structure.

### Absence of a signal is not approval

The most dangerous shape a gate can take is one where "everything is fine" and "nothing ran" are the same value.

`blockingReview: 0` had three meanings: reviewed and clean, never reviewed, and reviewed two commits ago. GitHub's review action makes the middle one routine — it refuses to run on any PR that edits a workflow file, then **skips, posts no comment, and reports its check as SUCCESS.** The PRs most in need of review are exactly the ones that silently get none.

The fix is `reviewObserved`: require a review comment whose timestamp postdates the head commit, and block when there isn't one. That also catches the stale case, since a gate reading the _last_ bot comment will otherwise let a review of the previous commit stand in for a review of the code being merged.

The follow-on lesson, learned by shipping the first fix and watching it wedge a repo: **the cure for an ambiguous signal is to disambiguate it, not to make it mandatory.** Requiring a review made "nothing ran" loud, but it also made a repo with no reviewer unable to merge anything, with a failure message that reads exactly like a broken reviewer. `review.mode` separates the two questions — is this signal load-bearing here, and did it actually fire — so a repo can honestly answer "we don't gate on that" without the gate pretending it does. What stayed unconditional is the part a human produces without being coached: a `CHANGES_REQUESTED` state blocks whether or not reviews are required, because it is a position, not an absence.

Generalise it. For any check a gate depends on, ask what value it takes when the check never ran, and whether that value is distinguishable from success. If it isn't, the gate has a hole shaped exactly like your most important PR.

## Failure scope

### Run-fatal vs issue-fatal

A failure about **this** issue blocks this issue. A precondition that would fail identically for every item — sandbox credentials, docker, a runner binary, gh auth, a missing board field, a broken install command — is **run-fatal**: abort the run on first occurrence, release the claim back to Ready, touch nothing else.

`run --execute --sandbox` without the token once failed closed _per issue_ and burned an entire hand-curated Ready queue into Blocked in under a minute. The fail-closed was correct. The per-issue blame was not.

Check every such precondition once in a preflight so the run refuses to start rather than discovering it thirty times.

### Session outcomes have exactly four shapes

PR url · explicit already-resolved signal · clean empty no-op · failure.

A clean no-op with no signal is only a _candidate_ "already resolved" — corroborate against a prior merged PR that closes the issue, otherwise block. A clean no-op is indistinguishable from a silent give-up or a refusal.

Trust an explicit signal only end-anchored, alone on the last line, over a clean tree. A signal over a dirty tree or after a crash is self-contradictory: treat as failure.

Timeout and kill every headless session. A stalled session must never hold a claim forever.

## The review loop

### Cap it at four rounds

The auto-reviewer is stateless and re-derives from scratch each round, so every fix push triggers a deeper pass and it never converges.

Measured on a pull request adding a **50-line guard test**: six rounds, findings per round 3 → 6 → 3 → 3 → 3 → 3. Nothing substantive after round three. Rounds five and six asked for flag-preservation logic for flags that don't exist, word boundaries for identifiers that don't exist, and file-missing handling for files that are always checked out.

The escape hatch is a mechanic worth knowing: **a PR comment does not trigger re-review, only a push does.** Rebutting a finding with a `file:line` citation is free. Stop pushing and the loop terminates.

### Whatever produced a signal must re-verify it

A fix loop fed both typecheck errors and review findings, but re-running only the typechecker between rounds, exits on green and reports already-fixed bugs as unresolved. A semantic finding does not move a typechecker.

## Git safety

### Push with an explicit refspec, always

```bash
git push origin <branch>:<branch>     # not: git push -u origin <branch>
```

With `push.default=upstream` and a worktree branched from `origin/<base>`, a bare `git push -u origin <branch>` resolves its **destination** from the upstream and writes the base branch. Seven accidental direct-to-main pushes in the source repo, two of them by agents. `-u` does not save you: it applies after refspec resolution, and the protect-main hook printed "Passed" every time.

`git branch --unset-upstream` right after `worktree add` makes an unpinned push fail loudly instead.

Recovery from a bad push to a shared branch is revert-forward. Never force-push a shared main.

### Never delete branches by glob

A cleanup meant for ten branches ran `git for-each-ref 'refs/heads/fix/*' | xargs git branch -D` and deleted **fifty-four**, including eight unmerged local-only branches from months of prior work. It was recoverable only because `branch -D` prints `(was <sha>)`. Log that output.

Delete from an explicit classified list. Prune conservatively: delete only on "issue affirmatively closed AND confirmed not the head of an open PR". **A failed lookup is not a passed safety check** — keep.

When auditing a recovered sha, note that a squash-merged tip is not an ancestor of main, so `merge-base --is-ancestor` will report false loss.

### Diff against the merge-base, not the remote ref

Linked worktrees share one ref store. A peer lane's fetch advances `refs/remotes/origin/main` past your base, and a diff-based review then reports other lanes' merged work — reversed — as your regressions. HIGH-severity "this guard was removed" findings, in files the branch never touched.

Sanity check: if `git diff origin/<base> --stat` lists files your branch never touched, your base is stale.

### Never lose the work

Before removing a failed session's worktree, salvage the dirty tree to a run-scoped WIP branch (`loop/<n>-wip-<runid>` — run-scoped because a retry's `-B` resets the reusable branch).

- **Verify the salvage captured everything before reporting that it did.** A false "preserved" is worse than none.
- **Skip salvage once the branch is pushed.** The remote is the durable copy; a local duplicate is a misleading signal, not a safety net.

Related hazard: never `git stash drop` after a conflicted `git stash pop`. The stash is still needed. Recover via `git fsck --unreachable | grep commit`, then `git stash store`.

## Quota

### API quota exhaustion looks like a broken board

Two separate per-token pools, and only one of them funds the loop's control plane. Projects v2 is GraphQL-only, so board traffic drains `graphql` while REST `core` sits nearly untouched. The symptom is a failure at `gh project field-list` while every `gh issue` and `gh pr` command still works perfectly, which reads as "my config points at the wrong board", not "wait forty minutes".

Measured: building a 53-item Ready queue (one board mutation per item) plus a handful of `plan` runs consumed 4,942 of 5,000 GraphQL points. REST core was at 4,998 the whole time.

The cost is front-loaded and scales with the queue, not the work: `buildQueue` spends a `gh issue view` **per Ready item** plus a sub-issue query per candidate, so a 50-item board costs ~100 points every time the queue is ranked. That is why the queue is built once per invocation and not per tick — per-tick rebuilding exhausted a 385-item board after two claims.

`gh api rate_limit` reads both pools and **is itself free**, so there is no reason to ration the check. `hamster doctor` reports both, `preflight` refuses to start an exhausted run, and a check before each claim stops a run cleanly rather than dying mid-pipeline holding a claim. Rate-limit errors are classified run-fatal: unclassified, a quota wall blocks every item in the queue in turn for an account-wide condition.

### Session quota exhaustion looks exactly like a catastrophic night

Headless sessions can share the operator's subscription quota — no separate API key means the same limit as interactive use. Roughly ten large-model implement sessions per wave was the practical ceiling.

The signature is unmistakable once you know it: **a burst of instant failures at about one per minute with tiny transcripts (~40 KB).** A real failure is one issue with a ~1 MB transcript. You can triage a night's failures with `du` before reading a single line.

On any "no PR url" failure, read the captured session stdout _first_. If it's the session-limit message, the fix is re-queue and relaunch after reset, not debugging the issue.

Two corollaries: review sessions count against the same budget, so ten issues is about eighteen sessions, not ten. And priority-ordering the queue is what decides whether the work that survives the quota is the work that mattered.

Schedule wave launches just after the quota reset so the whole window belongs to the loop.

## Recovery

### A driver killed mid-gate is finished by hand

Do **not** restart the loop for that issue. The item is already In Review so a re-run skips it, and forcing it spawns a fresh implement session that redoes finished work or collides with the open branch.

Finish the gate manually, in the loop's exact order: criteria vs diff → CI green → human-rule guard on changed files/labels → review settled → merge → set the board Done yourself → worktree and branch cleanup, salvaging first if the tree is dirty.

## Parallel waves

Everything below applies once you run more than one lane. The serial loop avoids all of it.

- **Idle agents don't poll CI.** They go quiet after opening a PR. Never re-ping an idle agent; reconcile from repo state — did the branch sha move, does a PR exist, are checks green.
- **N lanes exhaust the GraphQL quota** (~20 minute lockout) — the same wall described under Quota above, reached N times faster. Everything PR-shaped has a REST equivalent, and REST is a separate pool: REST-first for PR ops, and batch the Projects v2 board mutations (GraphQL-only) into start and end sweeps.
- **`cancel-in-progress` is correct for tests and catastrophic for deploys.** Six back-to-back merges each cancelled the previous run, so five intermediate deploy jobs never executed and five services silently ran pre-batch code. If a merge has side effects, it cannot share a cancellable concurrency group with CI.
- **Parallel branches off one base collide on generated sequence numbers** (migration files being the classic). Whoever merges second regenerates. Never hand-renumber.
- **The same collision applies to any committed derived file**, and it is easier to miss because there is no number to notice: a generated catalog, a bundled type file, a committed lockfile. Each PR snapshots it at branch time, so the first merge invalidates every sibling's copy and their drift guards fail on the merge ref. If a batch's issues all regenerate one artifact, that batch is serial — lane count is a property of the work, not of the machine. Where one PR _changes the shape_ of the derived file rather than just its contents, merge that one last, after a fresh base merge and a regenerate.
- **Branch protection that requires up-to-date-with-base serialises the batch anyway.** Merging one PR puts every open sibling `BEHIND`; each needs `gh pr update-branch`, which re-triggers its whole CI run. Parallel lanes there buy extra CI, not throughput.
- **Stacked PRs:** merging a parent with `--delete-branch` auto-closes its children. Merge children first, or retarget before the parent merges.
- **Before declaring a merge train done, the open-PR count must be zero.** Phase lists drift. The zero check doesn't.

## Post-mortems

**The board shows state; only the run log shows cause.** `~/.hamsterwheel/runs/<owner>-<repo>/<ts>.jsonl` is one
JSON object per event — `claim`, `implement-session` (with the resolved runner/model/effort),
`pr-open`, `review-fix` (with the finding count per round), `gate` (with every signal and the
decision), then `merged` / `blocked` / `failed` / `done`. An issue that ended `Blocked` tells you
nothing about whether it burned four review rounds first, ran an hour at the wrong effort, or died on
a precondition. The jsonl does.

Worth reading it for the shape of a run, not just its failures:

- **`implement-session` durations and the effort each resolved to.** If most of a night went to
  sessions running the strong tier on small work, the tier config is the finding, not any one issue.
- **`review-fix` rounds with a flat finding count** (1 → 1 → 1 → 1, then blocked) means the reviewer
  is re-deriving rather than converging. That is a cap-and-rebut problem, not a code problem.
- **Aborted runs** — a start event with nothing after it — are the signature of an environmental
  wall, usually quota. Several in a short window is a pattern, not bad luck.
- **The same issue claimed across multiple run ids** means work is being redone; check that salvage
  is being resumed rather than re-derived.

For "is it alive right now" the run log is the wrong tool — it cannot distinguish a dead run from a
slow one, because both stop appending. That is what `hamster status` and its heartbeat are for.

## Trust boundaries

- Issue titles and bodies are **untrusted third-party data**. Anyone with repo access, or a community submission promoted into an internal issue, authors them. Screen with injection tripwires and wrap in an unguessable per-run fence the content cannot forge. Use `crypto.randomUUID`, never a timestamp — timestamps are guessable.
- Tripwires are deliberately blunt and will produce false positives on ordinary technical prose. Read `plan`'s skip list rather than assuming a quiet queue is an empty one. (A real one: an issue titled `%/_ act as wildcards ...` was quarantined by a `role-hijack` marker matching a bare "act as".)
- **In-process hardening is defense-in-depth, not isolation.** Tool allow-lists, env scrubs and fenced prompts do not contain a session: `Edit`/`Write` reach absolute paths, scoped `Bash` runs arbitrary code, on-disk credentials stay readable. The container is the only real boundary.
- Forward environment variables **by name** (`--env FOO`), never `FOO=value`. Argv is world-readable via `ps`.
- Tokens fail closed. No silent fallback to host credentials.
- Scan the mounted `.git/config` for `credential.helper`, userinfo-in-URL and `url.*.insteadOf` before running. Any hit refuses: credentials could ride the mount in, or the push could be hijacked away from the injected token.

## Model policy

Route small mechanical work to cheap models and anything with design or blast-radius risk to big ones. Unsized defaults to expensive.

Per-issue override labels must be validated, and an invalid value must fall back rather than reach the spawn — a bad value at the spawn exits non-zero and reads as a generic session failure, sending you to debug the wrong thing.

Cross-vendor review is not a gimmick: a reviewer sharing the implementer's blind spots is worth much less than one that doesn't.
