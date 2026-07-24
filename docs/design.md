# hamsterwheel — loop design

Target architecture for the config-driven loop driver (roadmap items in CLAUDE.md). Generalized from the production plan + weeks of overnight runs on the source repo; CLAUDE.md's design lessons are the "why" behind most choices here.

## Philosophy

Thin **deterministic driver** + model-driven per-issue sessions. Safety-critical decisions (merge, migration parking, claim, reconcile) are code — `@hamsterwheel/gate` — not LLM judgment. The LLM does the creative work (implement, fix findings) in sandboxed headless sessions; a fresh adversarial session grades the result.

## Control plane: GitHub Projects v2

One project board is the single source of truth — no external tracker, no sync boundary.

| Field | Type | Values |
|---|---|---|
| Status | single-select | Draft · Ready · In Progress · In Review · Blocked · Done |
| Priority | single-select | P0 · P1 · P2 · P3 |
| Size | single-select | XS · S · M · L · XL |
| Owner | text | run-id of the claiming session |
| Blocked reason | single-select | needs-criteria · needs-prod-migration · needs-decision · dep-open · ci-red · rubric-fail |

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

## Per-issue pipeline

1. **Claim** — Status→In Progress, Owner=run-id, claim comment. Roll every claim step back if any step fails.
2. **Worktree** — `git worktree add -B <branch-prefix>/<n>-<slug>` off a freshly-fetched base; `git worktree prune` first; run the configured install cmd.
3. **Implement** — headless session inside the sandbox (`@hamsterwheel/sandbox`): fenced issue + criteria, explicit output contract (PR url on the last line | ALREADY-RESOLVED signal). Wall-clock timeout, then kill.
4. **Classify** — `classifyImplement`: `pr` | `resolved` | `maybe-resolved` (corroborate with a prior merged closing PR before Done) | `fail` (salvage the dirty tree to a WIP branch).
5. **Review loop** — wait for the configured review bot; triage every finding; fix NEW ones, rebut re-raised ones with file:line (the reviewer is stateless); bounded iterations.
6. **Rubric gate** — fresh adversarial READ-ONLY session grades each criterion against the resulting codebase; `applyCiToRubric` credits execution-dependent criteria from CI; `parseRubricVerdict` parses the verdict.
7. **Merge gate** — `mergeDecision`: CI green → no migration (config path regex) → no blocking review findings → rubric pass. Any miss → Blocked with the matching reason. Squash-merge, delete branch.
8. **Post-merge (configurable hooks)** — wait for the deploy workflow; run the smoke command. Failures notify; never auto-rollback.
9. **Close** — Status→Done, close comment (PR, commit, smoke result).
10. **Cleanup** — remove the worktree (salvage first if dirty), prune stale salvage branches conservatively.

## Hard human gates

Never automated, regardless of config:

- **Schema migrations to prod** — the merge parks as Blocked: needs-prod-migration; a human applies.
- **Releases** — the loop accumulates notes; a human cuts.
- **Anything irreversible or outward-facing** beyond merge+deploy+smoke → notify, don't act.

## Failure & reconciliation

- CI red after N fix rounds → Blocked: ci-red.
- Unresolvable merge conflict → one rebase attempt; still red → Blocked: needs-decision.
- Session crash/timeout → reap: no PR → salvage + back to Ready; PR open → stays In Review (resumable).
- Driver restart → reconcile from repo state, never from memory: In Progress/In Review with no live session → resume from the PR if open, else reset to Ready. Idempotent by issue #.
- Driver killed mid-gate with a PR open: do NOT re-run the loop for that issue — finish the gate manually in the loop's order (see CLAUDE.md ops lessons).
- Notify on every gate hit + empty queue.

## Concurrency

Serial by default: one issue start→merge→next, so double-claims and cross-PR merge collisions are impossible by construction. Wave mode adds bounded parallel on the same state model: atomic claim (Owner compare-and-set), merge queue, dependency-aware scheduling, REST-first GitHub ops, regenerate colliding generated sequences (migration numbers etc.) on second merge.

## Config (`hamsterwheel.toml`)

repo slug · project board · base branch · branch prefix · review bot name + blocking-severity regex · migration path regex · install cmd · smoke/deploy hooks · allowed tools · model policy (default + validated label override) · session timeout · retry caps.

## Observability

- Issue comment timeline = the audit log (claim, PR, review rounds, rubric verdict, merge, smoke, close).
- Board = at-a-glance state.
- Structured run log: `~/.hamsterwheel/runs/<ts>.jsonl`.

## Open questions

- Rubric strictness: hard-block on any unmet criterion vs allow justified "N/A".
- Idle behavior: sleep-poll cadence vs webhook wake (board item edited).
- Should the loop draft acceptance criteria for criteria-less issues (post them + Blocked: needs-criteria) or stay fully hands-off?
