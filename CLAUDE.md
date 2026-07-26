# hamsterwheel 🐹

Autonomous issue-loop infrastructure for coding agents: an OS-isolation sandbox runner for headless agent sessions, a pure merge-gate kit, and (eventually) a config-driven loop CLI. You sleep, the hamster runs the wheel.

Extracted from a production loop that ran overnight autonomous implementation waves on the squirrelscan monorepo (`scripts/issue-loop.ts` there). The lessons below are paid for — don't relearn them.

## Workspace

- `apps/cli` — the `hamsterwheel` CLI (bun; the loop driver lands here)
- `packages/sandbox` — docker sandbox runner: argv builder, env resolution, git-config credential scan, image + entrypoint
- `packages/gate` — pure, tested policy: merge decision, rubric/CI reconciliation, outcome classification, injection screen, salvage/prune

## Development

- bun everything (`bun test`, `bun run lint` = oxlint, `bun run format` = oxfmt). Never node/npm.
- Typecheck per package: `cd <pkg> && bunx tsgo --noEmit`.
- TypeScript strict; kebab/snake-case filenames.
- Conventional commits `type(scope): msg`. Direct pushes to `main` are fine while pre-1.0/solo.
- Security-critical behavior (sandbox argv construction, what crosses the env/fs boundary, gate decisions) MUST be pure functions with unit tests — that separation is the point of the package split.

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

### Session outcomes

- An implement session ends exactly 4 ways: PR url · explicit already-resolved signal · clean empty no-op · failure. A clean no-op with NO signal is only a CANDIDATE "already resolved" — corroborate with a prior merged PR that closes the issue, else block: a clean no-op is indistinguishable from a silent give-up or refusal.
- Trust the explicit signal only end-anchored, alone on the last line, on a clean no-op. A signal over a dirty tree or a crash is self-contradictory → failure.
- Timeout every headless session and kill it — a stalled session must not hold a claim forever. Roll the claim back if any claim step fails.

### Never lose work

- Before removing a failed session's worktree, salvage the dirty tree onto a run-scoped WIP branch (`loop/<n>-wip-<runid>` — run-scoped because a retry's `-B` resets the reusable impl branch). Verify the salvage actually captured everything before claiming it did; a false "preserved" is worse than none.
- Skip salvage once the branch is pushed — the remote is the durable copy; a local duplicate is a misleading signal.
- Prune salvage branches conservatively: delete only on "issue affirmatively closed AND confirmed not the head of an open PR". A failed lookup is NOT a passed safety check — keep.
- Worktrees: `worktree add -B` not `-b` (re-runs reuse the branch name), `git worktree prune` first (dir-less registrations block `-B`), fetch the base branch per issue so late items branch off the latest merged main.

### Operating at scale (parallel waves)

- Parallel agents idle silently after opening a PR — they don't poll CI. Never re-ping an idle agent; reconcile from repo state (branch sha moved? PR exists? checks green?).
- N lanes polling GitHub exhaust the GraphQL quota (~20 min lockout). GraphQL and REST "core" are separate per-token pools, and `gh api rate_limit` reads both for free; everything PR-shaped (create, checks, comments, merge) has a REST equivalent. REST-first for PR ops in anything parallel; batch board mutations (Projects v2 is GraphQL-only) to start/end sweeps.
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

1. Config-driven driver in `apps/cli`: `hamsterwheel.toml` (repo, project board, review bot, migration path regex, allowed tools, branch prefix, install cmd, model policy) behind `plan` / `once` / `run` / `triage` / `prune`. See `docs/design.md`.
2. Board bootstrap (`hamsterwheel init`): idempotent GitHub Projects v2 provisioning (Status options, Owner, Blocked reason).
3. Sandbox follow-ups: deny-by-default egress proxy, per-run GitHub App token minting, hermetic in-container clone.
4. Wave mode: parallel lanes encoding the at-scale lessons above.
5. npm publish decision (`hamsterwheel` is free on npm; `@hamsterwheel/*` scope needs the org).
