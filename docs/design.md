# hamsterwheel — loop design

Target architecture for the config-driven loop driver (roadmap items in CLAUDE.md). Generalized from the production plan + weeks of overnight runs on the source repo; CLAUDE.md's design lessons are the "why" behind most choices here.

## Philosophy

Thin **deterministic driver** + model-driven per-issue sessions. Safety-critical decisions (merge, human-rule parking, claim, reconcile) are code — `@hamsterwheel/gate` — not LLM judgment. The LLM does the creative work (implement, fix findings) in sandboxed headless sessions; a fresh adversarial session grades the result.

## Control plane: GitHub Projects v2

One project board is the single source of truth — no external tracker, no sync boundary.

| Field          | Type          | Values                                                                                       |
| -------------- | ------------- | -------------------------------------------------------------------------------------------- |
| Status         | single-select | Draft · Ready · In Progress · In Review · Blocked · Done                                     |
| Priority       | single-select | P0 · P1 · P2 · P3                                                                            |
| Size           | single-select | XS · S · M · L · XL                                                                          |
| Owner          | text          | run-id of the claiming session                                                               |
| Blocked reason | single-select | needs-criteria · needs-human · needs-decision · dep-open · ci-red · ci-timeout · rubric-fail |

Status semantics (the whole human⇄loop interface):

- **Draft** — human scratch state; loop ignores.
- **Ready** — has acceptance criteria + priority + size + no open deps; eligible.
- **In Progress** — claimed: Owner = run-id, claim comment (branch, worktree, timestamp).
- **In Review** — PR open + linked.
- **Blocked** — loop skips; Blocked reason says why; a human resolves.
- **Done** — merged but not yet released (+ deployed/smoked where configured); close comment with PR link. `hamster release` archives Done items when their version ships, so the board stays a queue, not a history.

Roles: **human = PM** (file issues, write acceptance criteria, set priority/size, flip Draft→Ready). **Loop = IC** (everything Ready→Done). `hamsterwheel init` provisions the board idempotently.

## Issue contract

Ready requires the body to contain (else → Blocked: needs-criteria):

```
## Acceptance Criteria
- [ ] <observable, checkable behavior>

## Depends on        (optional)
- #NNN
```

- The criteria checklist IS the rubric. CI-green ≠ requirement-met; the rubric gate scores the resulting codebase against each checkbox.
- `Depends on` + native sub-issues gate selection: parent/dep must be closed first.
- Issue titles/bodies are untrusted third-party input everywhere they touch a prompt — screen + fence (`@hamsterwheel/gate` untrusted).

## Selection (per tick)

1. Board query: Status == Ready.
2. Drop items a **person** has claimed — see "Community guard" below.
3. Drop items with open deps/parents (leave them Ready; they self-enable when the dep closes).
4. Sort: Priority (P0→P3) → Size (smaller first, fast wins) → age (oldest first).
5. Take head; none → idle poll (notify when the queue is empty and nothing is in flight).

Cross-check issue state, not just board status: items linger in Ready after a merged PR closed them, and working one burns a session redoing shipped work. Every eligibility rule must also be visible in a read-only `plan` that prints WHY each excluded issue was excluded — a silent eligibility failure (a mistyped criteria heading) looks exactly like an empty backlog, which is the worst failure mode the loop has.

### Community guard

An issue a person has claimed is not the loop's to take. Three signals, any one of which parks it as Blocked: needs-human (`community_guard = true`, the default):

- an **assignee** who is not a bot — someone with write access made a deliberate statement about ownership;
- a **comment from outside the org** (author association not OWNER/MEMBER/COLLABORATOR, login not `*[bot]`);
- the **`hands_off_label`** (`loop:hands-off` by default), which excludes an issue permanently.

This exists because of a real incident, and the shape of that incident is the argument for the design. A drive-by contributor commented "I'd like to work on this" with an accurate plan of attack; twenty-two minutes later the loop claimed the same issue, and twenty-five minutes after that it had merged a PR implementing essentially that plan. Nothing in the selection path could see the comment: the loop read an issue's title, body and labels, which is to say it was blind to both places a human says "mine".

Notice that the comment is the load-bearing signal, not the assignee. A contributor without write access **cannot** self-assign, so on a public repo the comment is the only way they can speak.

The check is deliberately blunt — a bare "+1" blocks the issue. A false positive costs a maintainer a few seconds to wave it through; a false negative costs a contributor their afternoon and the project a contributor. On a private board every commenter is in-org, so the guard is silent there without needing to know anything about repo visibility.

Two placements, because one is not enough: at queue build (the whole Ready set) and again immediately before the claim. In wave mode a queue can be minutes or hours old by the time a lane reaches an item, and "someone volunteered while we were busy" is precisely the case worth catching late. The re-check fails OPEN on a network error — a lookup failure must not stall the loop, and the same check already ran once.

`assignees` and `comments` ride along on the `gh issue view` call selection already makes, so the guard costs no extra API request. The claim-time re-check is one call per claim, not per board item.

The loop does **not** comment on an issue it parks this way. The maintainer needs to know; the volunteer does not need a bot posting into the thread they just volunteered in.

## Per-issue pipeline

1. **Claim** — Status→In Progress, Owner=run-id, claim comment. Roll every claim step back if any step fails.
2. **Lane** — a persistent worktree from the `worktree_lanes` pool (`<worktree_root>/<repo>/lane-<i>`), reused across issues so node_modules/caches stay warm. Acquire is salvage-first: leftover work from a crashed run is committed to a durable WIP branch BEFORE `reset --hard` + `clean -fd` (never `-x`); then branch `-B <branch-prefix>/<n>-<slug>` off a freshly-fetched base (fetch per issue, so late items branch off the latest merged base); `git branch --unset-upstream` immediately after, so an unpinned push fails loudly instead of resolving its destination from the inherited upstream and landing on the base branch; copy `.worktreeinclude` files (worktrees are born without git-ignored env files); run the configured `[scripts]` setup command with `HAMSTER_*` context env vars (incremental on a warm lane; `HAMSTER_LANE_COLD` tells the script which case it is). Every push the loop issues or instructs carries an explicit refspec (`git push origin <branch>:<branch>`) — only a refspec containing `:` pins the destination.
3. **Implement** — headless session inside the sandbox (`@hamsterwheel/sandbox`): fenced issue + criteria, explicit output contract (PR url on the last line | ALREADY-RESOLVED signal). Wall-clock timeout, then kill.
4. **Classify** — `classifyImplement`: `pr` | `resolved` | `maybe-resolved` (corroborate with a prior merged closing PR before Done) | `fail` (salvage the dirty tree to a WIP branch).
5. **Review loop** — wait for the configured review bot; triage every finding; fix NEW ones, rebut re-raised ones with file:line (the reviewer is stateless). **Cap: 4 rounds** (`max_review_rounds`). The reviewer re-derives from scratch every run, so each fix push triggers another deeper pass and it never converges: measured on a ~50-line PR, 6 rounds with findings 3→6→3→3→3→3, nothing substantive after round 3-4, and rounds 5-6 objecting to flags and identifiers that do not exist. The escape hatch is that a PR _comment_ does not trigger re-review — only a push does — so the loop posts the remaining findings as a comment and parks the PR for a human. Whatever produced a signal must be what re-verifies it: re-run the review, not just CI.
6. **Rubric gate** — fresh adversarial READ-ONLY session grades each criterion against the resulting codebase; `applyCiToRubric` credits execution-dependent criteria from CI; `parseRubricVerdict` parses the verdict. Diff against the **merge-base**, never the live `origin/<base>` ref: linked worktrees share one ref store, so a peer lane's fetch advances it and the diff then shows other lanes' merged work reversed — a review once raised HIGH-severity "guard was removed" findings for files the branch never touched.
7. **Merge gate** — `mergeDecision`: CI green → no `[[human]]` rule fired (config path regexes + issue labels) → nobody has requested changes → review provenance (only when `review.mode = "required"`) → no blocking review findings → rubric pass. Any miss → Blocked with the matching reason. Squash-merge, delete branch.

   `review.mode` decides how much a server-side review counts: `optional` (default) honours a review if one exists but never demands one, on the view that CI is the essential gate and reviewing may have happened locally; `required` additionally demands a review covering the current head; `off` skips the review API entirely. A CHANGES_REQUESTED review from any reviewer blocks under `required` and `optional` — it is a human withholding approval, not a finding with a severity to weigh — but `off` cannot see it, since it makes no review calls at all.

8. **Post-merge (configurable hooks)** — wait for the deploy workflow; run the smoke command. Failures notify; never auto-rollback.
9. **Close** — Status→Done, close comment (PR, commit, smoke result).
10. **Cleanup** — release the lane (salvage first if dirty, then detach so no branch ref is held; the dir stays warm for the next issue), prune stale salvage branches conservatively.

## Hard human gates

Never automated, regardless of config:

- **Anything matching a `[[human]]` rule** (schema migrations to prod being the canonical, required rule; security/auth/payments labels and sensitive paths optional) — the merge parks as Blocked: needs-human naming the fired rule(s); a human reviews/applies.
- **Releases** — the loop accumulates; a human cuts, via `hamster release` (below).
- **Anything irreversible or outward-facing** beyond merge+deploy+smoke → notify, don't act.

## Releases (`hamster release`)

The issue→version mapping is DERIVED from repo state, never recorded on the board: commits between semver tags → PRs (squash-title suffix) → the issues those PRs closed (`closingIssuesReferences`, batched). A per-item "Release" board field would be manual toil that drifts; git already holds the exact mapping.

Human-invoked only (the "never cut unattended" gate is the human typing the command). Preview by default; `--execute` requires an explicit `--tag` (a suggested conventional-commit semver bump is printed, never auto-applied), creates the tag + GitHub Release pinned to the **remote** base tip, then archives exactly the shipped Done items — Projects v2 archive, restorable, issue untouched. Archive-on-release is what gives Done its semantic ("merged, not yet released") and keeps the board under the ~1200-item cap without losing anything: the history now lives in the release notes. Safety mirrors prune: an item is archived only when its issue is affirmatively closed; a failed lookup is a keep, reported separately from a failure. `--archive-done` is the backfill arm for boards that predate the command.

## Failure & reconciliation

**Run-fatal vs issue-fatal (the taxonomy the whole failure model hangs off).** A failure that is about
THIS issue blocks THIS issue. A failure that would recur identically for every item — missing sandbox
credentials, no docker, a runner not on PATH, broken gh auth, a board field that doesn't exist, an
setup script that can't run — is RUN-FATAL: it aborts the run on first occurrence, releases the
in-flight claim back to Ready, and touches nothing else. The motivating incident: `run --execute
--sandbox` launched without the sandbox token failed closed _per issue_, so it claimed → blocked →
advanced, and destroyed a hand-curated Ready queue in under a minute. The security behaviour was
correct; treating an environment error as an implement failure was not. Every such precondition is also
checked ONCE in a preflight, so the run refuses to start rather than draining the queue.

**API quota is run-fatal, and disguised.** GitHub's GraphQL and REST `core` budgets are separate per-token
pools, and Projects v2 is GraphQL-only — so board traffic drains `graphql` while `core` stays full. The
loop then fails at `gh project field-list` with every `gh issue`/`gh pr` command still working, which reads
as a misconfigured board rather than a wall that clears itself on a timer. Cost is front-loaded and scales
with the QUEUE rather than the work (`enrichItem` is one `gh issue view` per Ready item), which is why
`buildQueue` runs once per invocation. `gh api rate_limit` reads both pools for free, so the check is
unconditional: `doctor` reports both, `preflight` refuses an exhausted start, each claim is preceded by a
re-check so running dry stops cleanly instead of dying mid-pipeline holding a claim, and rate-limit errors
are pattern-classified run-fatal so a quota wall cannot Block every item in turn.

- CI red after N fix rounds → Blocked: ci-red.
- CI never CONCLUDED within `ci_timeout_ms` → Blocked: ci-timeout, a distinct reason. Both are not-green and neither merges, but only one is the PR's fault: a timeout is a statement about runner-fleet depth, and reporting it as ci-red sends an operator to debug a failure that never happened. The board option defaults to whatever `ci_red` resolves to, so an existing board keeps working until it grows its own option.
- Unresolvable merge conflict → one rebase attempt; still red → Blocked: needs-decision.
- Session crash/timeout → reap: no PR → salvage + back to Ready; PR open → stays In Review (resumable). The next claim of that issue STARTS AT the salvage branch rather than at the base, and the implement prompt is told so — salvage that is never read back means a killed run's work is re-derived from scratch on every retry.
- Implement session ended without a PR url on its last line → before declaring failure, ask GitHub whether an open PR exists for the branch. The session's narration is not the authority on whether it opened a PR; an agent that did the work and then signed off with a summary is otherwise indistinguishable from one that crashed.
- Merging a DRAFT PR is impossible, and that check runs last — the gate marks a draft ready for review before merging, so a full passing gate is not discarded at the final API call.
- Driver restart → reconcile from repo state, never from memory: In Progress/In Review with no live session → resume from the PR if open, else reset to Ready. Idempotent by issue #. `hamster reconcile` reports; `hamster reconcile --release <n>` executes the decision once a human has made it. The release is a single verb because it has TWO halves — Status→Ready **and** clear the Owner — and doing half of it leaves an item that looks Ready but is skipped by the claim guard on every future run, leaking the issue out of the queue permanently and silently. `hamster status` is what tells you a driver died at all: a stale heartbeat is measurable, whereas a long implement phase and a wedged one look identical in the run log.
- A Done item whose issue was REOPENED is drift the board cannot see: reopening is how a human says "not actually finished", and nothing moves the item back. `reconcile` reports these; it does not fix them, because only the person who reopened it knows which way it should go.
- Driver killed mid-gate with a PR open: do NOT re-run the loop for that issue — finish the gate manually in the loop's order (see CLAUDE.md ops lessons).
- Notify on every gate hit + empty queue.

## Concurrency

`worktree_lanes = 1` (default) is serial: one issue start→merge→next, no locks allocated, and
double-claims and cross-PR merge collisions are impossible by construction.

`worktree_lanes > 1` is **wave mode**: N issues in flight at once, one per persistent lane worktree.
Serial execution was providing several guarantees implicitly, so each is re-established explicitly:

| what serial gave for free                                                     | what replaces it                                                                                                                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| no concurrent writes to shared `.git` (refs, worktree registry, `index.lock`) | a **git lock** around the shared-repo half of lane acquire/release — deliberately NOT held across `.worktreeinclude` copying or `scripts.setup`, which touch only the lane's own directory |
| no interleaved merges to the base                                             | a **merge lock**, so merges are ordered and the order is deterministic in the run log                                                                                                      |
| one issue per cursor position                                                 | a shared cursor: a worker only takes an item no other worker has been handed                                                                                                               |
| one pipeline's worth of API quota in flight                                   | the pre-claim quota floor is `PIPELINE_COST × lanes`                                                                                                                                       |
| attributable console output                                                   | every log line is tagged `[L<n>]` in wave mode                                                                                                                                             |

**Still not solved, and it matters:** the claim remains a read-then-write on the Owner field, NOT a
compare-and-set — Projects v2 has no conditional field update. Within one process the shared cursor
makes that irrelevant; **two driver processes against the same board can still double-claim.** And
ordering merges is not a merge queue: each PR's CI proved it green against the base as it was when
CI ran, so two individually-green PRs can still break the base when both land. A real merge queue
re-tests against the post-merge base; this does not. Dependency-aware scheduling and regenerating
colliding generated sequences (migration numbers etc.) on the second merge also remain unbuilt.

## Config (`hamsterwheel.toml`)

repo slug · project board (field + option NAMES, never hardcoded) · base branch · branch prefix · review bot name + blocking-severity regex · `[[human]]` rules (paths/labels) · community guard + hands-off label · `[scripts]` setup · worktree lanes · smoke/deploy hooks · allowed tools · runner+model+effort policy per role (strong/cheap tier pairs, flat overrides, validated label override) · session timeout · CI timeout · max review rounds · max iterations.

## Observability

- Issue comment timeline = the audit log (claim, PR, review rounds, rubric verdict, merge, smoke, close).
- Board = at-a-glance state.
- Structured run log: `~/.hamsterwheel/runs/<ts>.jsonl`.

## Open questions

- Rubric strictness: hard-block on any unmet criterion vs allow justified "N/A".
- Idle behavior: sleep-poll cadence vs webhook wake (board item edited).
- Should the loop draft acceptance criteria for criteria-less issues (post them + Blocked: needs-criteria) or stay fully hands-off?
