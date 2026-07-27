# hamsterwheel 🐹

Autonomous issue-loop infrastructure for coding agents: an OS-isolation sandbox runner for headless agent sessions, a pure merge-gate kit, and (eventually) a config-driven loop CLI. You sleep, the hamster runs the wheel.

Extracted from a production loop that ran overnight autonomous implementation waves on the squirrelscan monorepo (`scripts/issue-loop.ts` there). The lessons below are paid for — don't relearn them.

## Workspace

- `apps/cli` — the `hamster` CLI + loop driver (`init`/`doctor`/`plan`/`once`/`run`/`triage`/`reconcile`/`prune`)
- `packages/sandbox` — docker sandbox runner: argv builder, env resolution, git-config credential scan, image + entrypoint
- `packages/gate` — pure, tested policy: merge decision, rubric/CI reconciliation, outcome classification, injection screen, salvage/prune, queue selection, label-driven runner/model/effort routing
- `packages/runners` — claude/codex/opencode abstraction: pure argv builder, per-runner effort/model allow-lists, output normalization, PATH detection
- `packages/config` — `hamsterwheel.toml` schema, validation and loader

## Development

- bun everything (`bun test`, `bun run lint` = oxlint, `bun run format` = oxfmt). Never node/npm.
- Typecheck per package: `cd <pkg> && bunx tsgo --noEmit`.
- TypeScript strict; kebab/snake-case filenames.
- Conventional commits `type(scope): msg`. Direct pushes to `main` are fine while pre-1.0/solo.
- Security-critical behavior (sandbox argv construction, what crosses the env/fs boundary, gate decisions) MUST be pure functions with unit tests — that separation is the point of the package split.
- CLI conventions: agent-first. No interactivity (every input has a flag; `init` prompts only on a TTY and requires `--yes`/`--dry-run` otherwise), `--json` on EVERY command (one JSON object on stdout, human logs to stderr), per-command `--help` documenting flags, exit codes and the JSON shape, and flags are validated per command (a flag on the wrong command errors, never silently ignored). `apps/cli/src/args.ts` FLAG_SPECS is the single source of truth.
- `skills/hamsterwheel/SKILL.md` is the operator manual. Update it IN THE SAME CHANGE as anything user-facing: CLI commands/flags/output, board vocabulary, label routing, gate behavior, config schema. A stale skill silently teaches agents the old interface.

## Design lessons (from the source loop)

### Trust boundaries

- Issue titles/bodies are UNTRUSTED third-party data. Screen with injection tripwires (flagged → blocked for a human, never spawned) AND wrap in an unguessable per-run fence (`crypto.randomUUID`) the content can't forge. Timestamps are guessable; don't use them for fences.
- In-process hardening (tool allow-lists, env scrubs, fenced prompts) is defense-in-depth, NOT isolation. Edit/Write reach absolute paths, scoped Bash still runs arbitrary code, on-disk creds stay readable. The container is the only real boundary.
- Sandbox invariants: only the worktree + its git common dir cross, identity-mounted at their real absolute paths (linked-worktree gitdirs back-reference absolute host paths — git breaks otherwise). Env crosses by allow-list only and is forwarded by NAME (`--env FOO`, never `FOO=value` — argv is world-readable via `ps`). Tokens FAIL CLOSED: no silent fallback to host creds. Scan the mounted `.git/config` for `credential.helper` / userinfo-in-URL / `url.*.insteadOf` before running — any hit refuses (creds could ride the mount in, or the push could be hijacked away from the injected token).
- Open gaps the source loop never closed (roadmap here): deny-by-default egress, per-run token minting, fully hermetic in-container clone.

### The merge gate

- Deterministic gate order: CI → migration → blocking review findings → rubric. Every heuristic errs toward blocking — a false positive routes to a human, a false negative merges a bad PR.
- Schema migrations NEVER auto-merge. Releases are never cut unattended.
- The rubric grader is a fresh adversarial session with READ-ONLY tools that did not write the code, grading each acceptance criterion against the RESULTING codebase, not just the diff — a criterion may be satisfied by code already on main.
- Execution-dependent criteria ("tests pass", "typecheck clean") are OWNED by the deterministic CI gate; a read-only grader physically can't run them and will false-fail correct PRs. Credit them in code once CI is green (`applyCiToRubric`) — prompt instructions alone don't bind an LLM.
- Parse LLM JSON verdicts by scanning back from the last `}` with brace matching; models wrap JSON in prose.

### Run-fatal vs issue-fatal

- A failure about THIS issue blocks THIS issue. A precondition that would fail identically for every item (sandbox credentials, docker, a runner binary, gh auth, a missing board field, a broken install command) is RUN-FATAL: abort the run, release the claim back to Ready, touch nothing else. `run --execute --sandbox` without the token once failed closed _per issue_ and burned an entire curated Ready queue into Blocked in under a minute — the fail-closed was right, the per-issue blame was not. Check every such precondition once in a preflight so the run refuses to start.
- Unattended sessions need approval bypass at EVERY layer. A harness tool allow-list does not cover a runner's own consent model: codex needs `approval_policy="never"` + an explicit `--sandbox` mode, opencode needs `--auto`. Bake them into the argv, never into a README instruction.

### Session outcomes

- An implement session ends exactly 4 ways: PR url · explicit already-resolved signal · clean empty no-op · failure. A clean no-op with NO signal is only a CANDIDATE "already resolved" — corroborate with a prior merged PR that closes the issue, else block: a clean no-op is indistinguishable from a silent give-up or refusal.
- Trust the explicit signal only end-anchored, alone on the last line, on a clean no-op. A signal over a dirty tree or a crash is self-contradictory → failure.
- Timeout every headless session and kill it — a stalled session must not hold a claim forever. Roll the claim back if any claim step fails.

### Never lose work

- Before removing a failed session's worktree, salvage the dirty tree onto a run-scoped WIP branch (`loop/<n>-wip-<runid>` — run-scoped because a retry's `-B` resets the reusable impl branch). Verify the salvage actually captured everything before claiming it did; a false "preserved" is worse than none.
- Skip salvage once the branch is pushed — the remote is the durable copy; a local duplicate is a misleading signal.
- Prune salvage branches conservatively: delete only on "issue affirmatively closed AND confirmed not the head of an open PR". A failed lookup is NOT a passed safety check — keep.
- Delete branches from an explicit classified LIST, never a glob. A `for-each-ref 'refs/heads/fix/*' | xargs branch -D` meant for 10 branches deleted ~54, including unmerged local-only work from prior months; the `(was <sha>)` git prints was the only reason it was recoverable — log it. When auditing such a sha, note a squash-merged tip is NOT an ancestor of main, so `merge-base --is-ancestor` reports false loss.
- Push with an explicit refspec (`git push origin <branch>:<branch>`) everywhere. With `push.default=upstream` and a worktree branched off `origin/<base>`, a bare `git push -u origin <branch>` resolves its DESTINATION from the upstream and writes the base branch — seven accidental direct-to-main pushes in the source repo, two via agents. `-u` doesn't save you, and the protect-main hook printed "Passed". `git branch --unset-upstream` right after `worktree add` makes an unpinned push fail loudly.
- Diff against the merge-base, not `origin/<base>`. Linked worktrees share one ref store, so a peer lane's fetch advances the ref and a diff-based review then reports other lanes' merged work, reversed, as your regressions. Sanity check: if `git diff origin/<base> --stat` lists files the branch never touched, the base is stale.
- Worktrees: `worktree add -B` not `-b` (re-runs reuse the branch name), `git worktree prune` first (dir-less registrations block `-B`), fetch the base branch per issue so late items branch off the latest merged main.

### Bounded review rounds

- Cap review-fix rounds at 4. The reviewer is stateless and re-derives from scratch, so each fix push triggers a deeper pass and it never converges: on a ~50-line PR, 6 rounds with findings 3→6→3→3→3→3, nothing substantive after round 3-4, then objections to flags and identifiers that do not exist. Exit mechanic: a PR _comment_ does not trigger re-review, only a push does — post the remaining findings with citations and stop committing.
- Whatever produced a signal must be what re-verifies it. A fix loop fed review findings but re-checking only the typechecker exits on a stale signal and reports already-fixed bugs as unresolved.

### Operating at scale (parallel waves)

- Parallel agents idle silently after opening a PR — they don't poll CI. Never re-ping an idle agent; reconcile from repo state (branch sha moved? PR exists? checks green?).
- N lanes polling GitHub exhaust the GraphQL quota (~20 min lockout). GraphQL and REST "core" are separate per-token pools, and `gh api rate_limit` reads both for free; everything PR-shaped (create, checks, comments, merge) has a REST equivalent. REST-first for PR ops in anything parallel; batch board mutations (Projects v2 is GraphQL-only) to start/end sweeps.
- `cancel-in-progress` is correct for tests and catastrophic for deploys. Six back-to-back merges each cancelled the previous run, so five intermediate merges' deploy jobs never executed and five services stayed on stale code. If a merge has side effects, it cannot share a cancellable concurrency group with CI.
- Parallel branches off the same base collide on generated sequence numbers (e.g. migration files). Whoever merges second regenerates — never hand-renumber.
- Stacked PRs: merging a parent with `--delete-branch` auto-closes its children. Merge children first, or retarget before the parent merges.
- Before declaring a merge train done, the open-PR count must be zero. Phase lists drift; the zero check doesn't.

### Session quota + recovery

- Headless agent sessions can share the operator's subscription session quota (no separate API key → same limit as interactive use). ~10 big-model implement sessions per wave was the practical ceiling; schedule wave launches just after the quota reset so the window belongs to the loop, and priority-order the queue so the important work lands before the quota dies.
- Quota exhaustion has a signature: a rapid burst of instant session failures (~1/min, tiny transcripts) — nothing like a real failure (one issue, huge transcript). On a "no PR url" failure, read the captured session stdout FIRST; if it's the session-limit message, the fix is re-queue + relaunch after reset, not debugging the issue.
- Driver killed mid-gate with a PR already open: do NOT restart the loop for that issue — re-running skips In Review items, and forcing it spawns a fresh implement session that redoes finished work or collides with the open branch. Finish the gate BY HAND in the loop's exact order: criteria vs diff → CI green → migration guard on changed files → review settled → merge → set the board Done yourself → worktree/branch cleanup (salvage first if dirty).

### Model policy

- Route small mechanical work to cheap models, anything with design or blast-radius risk to big ones. Per-issue override labels must be validated — an invalid value falls back to the heuristic and must never reach the spawn (it would read as a generic session failure).

Target driver architecture: `docs/design.md`.

## What's next

1. Wave mode: parallel lanes encoding the at-scale lessons above (REST-first PR ops, merge queue, dependency-aware scheduling).
2. Post-merge hooks: wait for the deploy workflow, run `smoke_cmd`, notify on failure (never auto-rollback).
3. Sandbox follow-ups: deny-by-default egress proxy, per-run GitHub App token minting, hermetic in-container clone.
4. Review loop: iterate on review findings before the rubric gate (currently a blocking finding parks the PR for a human).
5. npm publish decision (`hamsterwheel` is free on npm; `@hamsterwheel/*` scope needs the org).
