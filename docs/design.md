# hamsterwheel — loop design

Target architecture for the config-driven loop driver (roadmap items in CLAUDE.md). Generalized from the production plan + weeks of overnight runs on the source repo; CLAUDE.md's design lessons are the "why" behind most choices here.

## Philosophy

Thin **deterministic driver** + model-driven per-issue sessions. Safety-critical decisions (merge, human-rule parking, claim, reconcile) are code — `@hamsterwheel/gate` — not LLM judgment. The LLM does the creative work (implement, fix findings) in sandboxed headless sessions; a fresh adversarial session grades the result.

## Control plane: GitHub Projects v2

One project board is the single source of truth — no external tracker, no sync boundary.

| Field          | Type          | Values                                                                          |
| -------------- | ------------- | ------------------------------------------------------------------------------- |
| Status         | single-select | Draft · Ready · In Progress · In Review · Blocked · Done                        |
| Priority       | single-select | P0 · P1 · P2 · P3                                                               |
| Size           | single-select | XS · S · M · L · XL                                                             |
| Owner          | text          | run-id of the claiming session                                                  |
| Blocked reason | single-select | needs-criteria · needs-human · needs-decision · dep-open · ci-red · rubric-fail |

Status semantics (the whole human⇄loop interface):

- **Draft** — human scratch state; loop ignores.
- **Ready** — has acceptance criteria + priority + size + no open deps; eligible.
- **In Progress** — claimed: Owner = run-id, claim comment (branch, worktree, timestamp).
- **In Review** — PR open + linked.
- **Blocked** — loop skips; Blocked reason says why; a human resolves.
- **Done** — merged (+ deployed/smoked where configured); close comment with PR link.

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
2. Drop items with open deps/parents (leave them Ready; they self-enable when the dep closes).
3. Sort: Priority (P0→P3) → Size (smaller first, fast wins) → age (oldest first).
4. Take head; none → idle poll (notify when the queue is empty and nothing is in flight).

Cross-check issue state, not just board status: items linger in Ready after a merged PR closed them, and working one burns a session redoing shipped work. Every eligibility rule must also be visible in a read-only `plan` that prints WHY each excluded issue was excluded — a silent eligibility failure (a mistyped criteria heading) looks exactly like an empty backlog, which is the worst failure mode the loop has.

## Per-issue pipeline

1. **Claim** — Status→In Progress, Owner=run-id, claim comment. Roll every claim step back if any step fails.
2. **Lane** — a persistent worktree from the `worktree_lanes` pool (`<worktree_root>/<repo>/lane-<i>`), reused across issues so node_modules/caches stay warm. Acquire is salvage-first: leftover work from a crashed run is committed to a durable WIP branch BEFORE `reset --hard` + `clean -fd` (never `-x`); then branch `-B <branch-prefix>/<n>-<slug>` off a freshly-fetched base (fetch per issue, so late items branch off the latest merged base); `git branch --unset-upstream` immediately after, so an unpinned push fails loudly instead of resolving its destination from the inherited upstream and landing on the base branch; copy `.worktreeinclude` files (worktrees are born without git-ignored env files); run the configured install cmd (incremental on a warm lane). Every push the loop issues or instructs carries an explicit refspec (`git push origin <branch>:<branch>`) — only a refspec containing `:` pins the destination.
3. **Implement** — headless session inside the sandbox (`@hamsterwheel/sandbox`): fenced issue + criteria, explicit output contract (PR url on the last line | ALREADY-RESOLVED signal). Wall-clock timeout, then kill.
4. **Classify** — `classifyImplement`: `pr` | `resolved` | `maybe-resolved` (corroborate with a prior merged closing PR before Done) | `fail` (salvage the dirty tree to a WIP branch).
5. **Review loop** — wait for the configured review bot; triage every finding; fix NEW ones, rebut re-raised ones with file:line (the reviewer is stateless). **Cap: 4 rounds** (`max_review_rounds`). The reviewer re-derives from scratch every run, so each fix push triggers another deeper pass and it never converges: measured on a ~50-line PR, 6 rounds with findings 3→6→3→3→3→3, nothing substantive after round 3-4, and rounds 5-6 objecting to flags and identifiers that do not exist. The escape hatch is that a PR _comment_ does not trigger re-review — only a push does — so the loop posts the remaining findings as a comment and parks the PR for a human. Whatever produced a signal must be what re-verifies it: re-run the review, not just CI.
6. **Rubric gate** — fresh adversarial READ-ONLY session grades each criterion against the resulting codebase; `applyCiToRubric` credits execution-dependent criteria from CI; `parseRubricVerdict` parses the verdict. Diff against the **merge-base**, never the live `origin/<base>` ref: linked worktrees share one ref store, so a peer lane's fetch advances it and the diff then shows other lanes' merged work reversed — a review once raised HIGH-severity "guard was removed" findings for files the branch never touched.
7. **Merge gate** — `mergeDecision`: CI green → no `[[human]]` rule fired (config path regexes + issue labels) → no blocking review findings → rubric pass. Any miss → Blocked with the matching reason. Squash-merge, delete branch.
8. **Post-merge (configurable hooks)** — wait for the deploy workflow; run the smoke command. Failures notify; never auto-rollback.
9. **Close** — Status→Done, close comment (PR, commit, smoke result).
10. **Cleanup** — release the lane (salvage first if dirty, then detach so no branch ref is held; the dir stays warm for the next issue), prune stale salvage branches conservatively.

## Hard human gates

Never automated, regardless of config:

- **Anything matching a `[[human]]` rule** (schema migrations to prod being the canonical, required rule; security/auth/payments labels and sensitive paths optional) — the merge parks as Blocked: needs-human naming the fired rule(s); a human reviews/applies.
- **Releases** — the loop accumulates notes; a human cuts.
- **Anything irreversible or outward-facing** beyond merge+deploy+smoke → notify, don't act.

## Failure & reconciliation

**Run-fatal vs issue-fatal (the taxonomy the whole failure model hangs off).** A failure that is about
THIS issue blocks THIS issue. A failure that would recur identically for every item — missing sandbox
credentials, no docker, a runner not on PATH, broken gh auth, a board field that doesn't exist, an
install command that can't run — is RUN-FATAL: it aborts the run on first occurrence, releases the
in-flight claim back to Ready, and touches nothing else. The motivating incident: `run --execute
--sandbox` launched without the sandbox token failed closed _per issue_, so it claimed → blocked →
advanced, and destroyed a hand-curated Ready queue in under a minute. The security behaviour was
correct; treating an environment error as an implement failure was not. Every such precondition is also
checked ONCE in a preflight, so the run refuses to start rather than draining the queue.

- CI red after N fix rounds → Blocked: ci-red.
- Unresolvable merge conflict → one rebase attempt; still red → Blocked: needs-decision.
- Session crash/timeout → reap: no PR → salvage + back to Ready; PR open → stays In Review (resumable).
- Driver restart → reconcile from repo state, never from memory: In Progress/In Review with no live session → resume from the PR if open, else reset to Ready. Idempotent by issue #.
- Driver killed mid-gate with a PR open: do NOT re-run the loop for that issue — finish the gate manually in the loop's order (see CLAUDE.md ops lessons).
- Notify on every gate hit + empty queue.

## Concurrency

Serial by default: one issue start→merge→next, so double-claims and cross-PR merge collisions are impossible by construction. **Serial execution is the actual guarantee — the atomic claim is NOT built.** What exists is claim-with-rollback plus a read-then-write guard on the Owner field; Projects v2 has no conditional field update, so two concurrent drivers can still race. Wave mode would need a real compare-and-set (or an external lock) on the same state model, plus a merge queue, dependency-aware scheduling, REST-first GitHub ops, and regenerating colliding generated sequences (migration numbers etc.) on the second merge.

## Config (`hamsterwheel.toml`)

repo slug · project board (field + option NAMES, never hardcoded) · base branch · branch prefix · review bot name + blocking-severity regex · `[[human]]` rules (paths/labels) · install cmd · worktree lanes · smoke/deploy hooks · allowed tools · runner+model+effort policy per role (default + validated label override) · session timeout · CI timeout · max review rounds · max iterations.

## Observability

- Issue comment timeline = the audit log (claim, PR, review rounds, rubric verdict, merge, smoke, close).
- Board = at-a-glance state.
- Structured run log: `~/.hamsterwheel/runs/<ts>.jsonl`.

## Open questions

- Rubric strictness: hard-block on any unmet criterion vs allow justified "N/A".
- Idle behavior: sleep-poll cadence vs webhook wake (board item edited).
- Should the loop draft acceptance criteria for criteria-less issues (post them + Blocked: needs-criteria) or stay fully hands-off?
