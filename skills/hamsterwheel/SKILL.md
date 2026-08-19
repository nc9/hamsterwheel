---
name: hamsterwheel
description: Set up and operate hamsterwheel, an autonomous GitHub-issue loop that implements, reviews, gates and merges issues unattended. Use when adopting hamsterwheel in a repo, writing loop-eligible issues, configuring hamsterwheel.toml, choosing runner/model/effort labels, running a batch, or debugging why the loop skipped, blocked or failed an issue.
---

# hamsterwheel

An autonomous issue loop: claim a Ready issue → worktree → headless implement session → PR → CI → adversarial rubric grade → deterministic merge gate → merge or Blocked-with-a-reason.

You are the PM. The loop is the IC. Your job is the board and the issue contract; its job is everything after `Ready`.

## The one rule

**`plan` before every batch. It mutates nothing.**

```bash
hamster plan
```

It prints the eligible queue in selection order, the resolved runner/model/effort per issue with a source key, and a skip reason for every excluded issue. On its first real repo it caught two bugs that would otherwise have surfaced as mystery 3am failures: a legitimate issue quarantined by an injection false positive, and a label combination resolving to a model id the target vendor has never heard of.

Silent eligibility failure is the worst failure mode in a system nobody is watching. An empty backlog and a broken filter look identical from the outside. `plan` is the difference.

## Adopting it in a repo

```bash
hamster doctor           # prerequisites: git, gh auth + project scope, docker, runner binaries
hamster init --dry-run   # every mutation init would make, printed, applied to nothing
hamster init             # provision board + labels, write hamsterwheel.toml, splice the contract
```

`init` splices the issue contract into `CLAUDE.md` and `AGENTS.md` between `<!-- hamsterwheel:start -->` markers, and rewrites in place on re-run. Splice it into **both** if your implement and review runners are different vendors: Claude reads CLAUDE.md, Codex reads AGENTS.md, and a contract only one of them can see is a contract only one of them follows.

Then, before the first batch, work `reference/adoption-checklist.md`. Four of its items are things that fail silently rather than loudly, and one of them defeats the merge gate entirely.

## The issue contract

An issue is eligible only with **both** an `## Acceptance Criteria` heading and at least one markdown checkbox under it:

```markdown
## Acceptance Criteria

- [ ] observable, checkable behavior
- [ ] one checkbox per requirement

Depends on #123 (optional; "Blocked by #123" also works)
```

The heading is matched literally and is typo-sensitive. `## Acceptance`, or a reworded heading, drops the issue out of the queue with no error anywhere. (`criteria_heading` in the config changes what's matched, but it's still literal.)

**The checklist IS the merge rubric.** A fresh adversarial read-only session grades the resulting codebase against every box. So write boxes a grader can settle by reading a diff:

- Good: "`SOCIAL_DISPLAY` keys derive from `(typeof siteConfig.socials)[number]["name"]`, so an unknown platform is a build error."
- Useless: "the footer is more robust."

Criteria the grader physically cannot run ("tests pass", "typecheck clean") are fine to write — the deterministic CI gate owns them and credits them in code once CI is green. Do not omit them; do not expect the grader to have run them.

Also required for eligibility: a priority label (`P0`–`P3`) and a size label (`size: XS`–`size: XL`). Unsized defaults to expensive, which is the right way round.

## Labels: runner, model, effort

Six independent axes, three per role. All optional.

| label                                                                   | effect                                     |
| ----------------------------------------------------------------------- | ------------------------------------------ |
| `loop:impl-runner-<claude\|codex\|opencode>`                            | which agent CLI implements                 |
| `loop:impl-model-<model>`                                               | model for the implement session            |
| `loop:impl-effort-<level>`                                              | reasoning effort for the implement session |
| `loop:review-runner-*` / `loop:review-model-*` / `loop:review-effort-*` | the same three for the rubric grader       |
| `loop:model-<model>`                                                    | legacy alias for `loop:impl-model-*`       |

Resolution per axis: **validated label → config default → heuristic → the runner's own default.** The heuristic sends P0/P1 or size ≥ M to the strong tier, and XS or docs/test/chore/style/ci-shaped work to the cheap one.

Both **model and effort** are tiered this way, via `strong_model`/`cheap_model` and `strong_effort`/`cheap_effort`. Configure the pairs, not the flat `model`/`effort`: a flat value applies to every issue and disables the heuristic on that axis. A run configured `effort = "high"` spent high effort on XS one-file changes and 4-file rule additions alike, which in a serial loop is the largest single source of wall-clock. Setting a flat value alongside its pair is a config error rather than a silent override.

An invalid label falls back **silently and deliberately**. A typo that reached the spawn would exit non-zero and read as a generic implement failure, and you would debug the wrong thing for an hour.

Effort vocabularies differ per runner and a foreign value is dropped, not translated:

| runner   | effort values                         |
| -------- | ------------------------------------- |
| claude   | `low` `medium` `high` `xhigh` `max`   |
| codex    | `minimal` `low` `medium` `high`       |
| opencode | `minimal` `low` `medium` `high` `max` |

**Model ids are opaque vendor tokens, so validation is shape-only.** Nothing can tell that `sonnet` is meaningless to Codex. Two consequences: a `loop:impl-runner-*` label that switches vendors discards the config's model tiers rather than forwarding them, and you should not pin a vendor model id in config unless you intend to maintain it — leave `strong_model`/`cheap_model` unset and the runner uses the operator's own default.

## Driving the CLI from an agent

The CLI is built to be driven headless — no command ever needs a human at the keyboard:

- **`--json` on every command**: exactly one JSON object on stdout (`{ ok, command, ... }`); all human progress text goes to stderr, so `hamster … --json | jq` always parses. Errors in `--json` mode are also JSON on stdout: `{ ok: false, error: { kind, message } }` with `kind` ∈ `usage | config | run-fatal | error`.
- **`hamster <command> --help`** documents that command's flags, exit codes, and the exact `--json` shape. Trust it over memory.
- **Flags are validated per command**: a flag on a command it doesn't apply to (e.g. `plan --delete`) exits 1 with the list of commands that accept it — it is never silently ignored.
- **`once`/`run` `--json`** replays the structured run-log events (`claim`, `pr-open`, `gate`, `merged`, `blocked`, `failed`, …) plus a summary with counts — the same events written to `~/.hamsterwheel/runs/*.jsonl`.
- **`init` never prompts off a TTY**: pass `--yes` to apply or `--dry-run` to preview (mandatory with `--json`); `--project-title <t>` overrides the default board title "<repo-name> Loop" (the repo name is in the default because most orgs run multiple boards).

## Lanes: how sessions get a working copy

Sessions never run in your checkout. Each issue runs in a **lane** — a persistent git worktree (`~/.hamsterwheel/worktrees/<repo>/lane-0`…) reused across issues so `node_modules` and build caches stay warm (the per-issue cost is an incremental setup, not a cold one).

`worktree_lanes` sizes the pool AND sets how many issues run at once:

- **`1` (default)** — the serial loop: one issue start→merge→next, no locks allocated.
- **`>1` — wave mode.** Implement sessions overlap, which is where the wall-clock is (12-60 min each). Shared-repo git operations (`fetch`, `worktree add/prune`, checkout) take a git lock, and the final `gh pr merge` takes a merge lock, so those stay ordered; the parallelism is in the sessions. Each log line is tagged `[L<n>]`. `once` always runs a single lane regardless.

Sizing: a lane costs disk plus one cold `scripts.setup`, so match it to what the machine can genuinely run concurrently. GitHub API quota is consumed per in-flight pipeline, and the pre-claim quota floor scales with lane count accordingly.

**Never run two driver processes against one board.** The claim guard is a read-then-write on the Owner field, not a compare-and-set (Projects v2 has no conditional field update). One process's lanes coordinate through a shared cursor; two processes do not, and will double-claim. Ordering merges is also not a merge queue: two individually-green PRs can still break the base when both land, because neither was tested against the other's result.

After every acquire hamster runs the configured setup script — `[scripts]` `setup` in `hamsterwheel.toml` (Conductor-style lifecycle table; `run`/`archive`/`maintenance` are reserved). It is argv-exec'd with **no shell** (pipes/`&&` belong in a repo script the config points at) and receives context env vars: `HAMSTER_WORKSPACE_PATH` (lane dir), `HAMSTER_WORKSPACE_NAME` (`lane-0`), `HAMSTER_ROOT_PATH` (primary checkout), `HAMSTER_LANE_COLD` (`1` fresh worktree / `0` warm reuse), `HAMSTER_ISSUE`, `HAMSTER_RUN_ID`. No `setup` configured → no setup step. The old `install_cmd` key is a hard config error. `hamster init` pre-fills `setup` from existing conventions when it can (`conductor.json` `scripts.setup`, `.cursor/environment.json` `install`, a `scripts/setup.sh`, or the lockfile's package manager) — detection happens only at init; the runtime obeys the explicit config alone.

Acquiring a lane for an issue is salvage-first: any leftover work from a crashed run is committed to a durable `<prefix>/<n>-wip-lane…` branch **before** the lane is reset (`reset --hard` + `clean -fd` — never `-x`, so ignored files survive), then the lane branches off the freshly fetched base and its upstream is dropped. A dirty lane whose salvage fails refuses to reset rather than destroy work. On release the lane detaches so it never holds a branch ref.

**Prepare your repo:** worktrees are born WITHOUT git-ignored files, so a session in a lane can't see your `.env` — builds and tests that need it fail in ways your main checkout never shows. Declare what must be copied in via `.worktreeinclude` at the repo root (gitignore-style globs, one per line, `#` comments; a bare name matches at any depth, `/`-containing patterns anchor to the root):

```
# copied into every lane before a session runs
.env
.env.*
.dev.vars
```

Files are re-copied fresh on every acquire (copies, never symlinks — a session can't corrupt the originals). `hamster doctor` has a `worktree ready` check that warns about env-style files no pattern covers, and `hamster init` offers to scaffold the file from what it detects.

## Running a batch

```bash
hamster once --execute --issue 42 --pr-only   # one issue, stop at the PR
hamster once --execute                        # one issue, full gate
hamster run  --execute                        # until the Ready queue is empty (serial, or N-wide with worktree_lanes)
hamster run  --execute --sandbox              # sessions OS-isolated in docker
```

`once`/`run` mutate the board **only** with `--execute`. `plan`, `reconcile`, `prune` (without `--delete`) and `release` (without `--execute`) never mutate GitHub or the board — `release`'s preview does run a `git fetch` so the notes derive from fresh refs.

### Cutting a version: `hamster release`

Releases are never cut unattended — this command IS the human cutting one, with hamster doing the bookkeeping. The issue→version mapping is **derived, never stored**: commits since the last semver tag → PRs (squash-title suffix) → the issues those PRs closed. No board field to maintain, nothing to drift.

```bash
hamster release                          # preview: notes, suggested semver bump, archive plan
hamster release --tag v0.5.0 --execute   # tag + GitHub Release (pinned to the remote base tip) + archive
hamster release --tag v0.5.0 --execute --changelog   # …and prepend CHANGELOG.md (commit left to you)
hamster release --archive-done --execute # backfill: archive every Done item whose issue is closed
```

Cutting a release **archives** the shipped Done items (Projects v2 archive — hidden from views and queries, restorable, the issue itself untouched), which is what gives `Done` its meaning: **merged but not yet released**. The board stays a queue; the history lives in the release notes and git. An item is archived only when its issue is affirmatively closed — a failed lookup keeps it, and keeps are reported separately from failures. `--archive-done` is the one-shot cleanup for a board that predates this command. `plan` also reports how many open issues are not on the board at all (`triage --sync` folds them in as Draft).

Start a new repo on `--pr-only`. It runs the identical pipeline and stops at the open PR, so you inspect real output before the merge path ever executes unsupervised. Graduate to the full gate once you've seen the reviewer emit a correctly-tagged blocking finding at least once — until then the blocking-review path is untested in that repo, and an untested gate arm reads as approval. If the repo has no review bot at all, that graduation never comes: run `review.mode = "optional"` and lean on CI plus the rubric, rather than leaving `required` set against a reviewer that will never speak.

## The merge gate

The merge decision is a pure function over its signals, evaluated in a fixed order:

```
CI → human-review rules → changes-requested → review provenance* → blocking review findings → rubric
                                              *only when review.mode = "required"
```

No model is ever asked "should this merge?" Models grade the rubric, which is a judgement call over English. Reconciling that grade with CI, human-review rules and review findings is deterministic tested code.

Never auto-merged regardless of how green things look: anything matching a `[[human]]` rule in `hamsterwheel.toml` (parked as `needs-human`, with the fired rule names in the reason), anything carrying a high or critical review finding, and anything a reviewer has requested changes on. Nits don't block.

### `review.mode` — how much a server-side review is worth

CI is the essential gate; a PR-comment review is defence in depth. The reviewing may well have happened locally, and plenty of repos have no review bot at all.

| mode                 | behaviour                                                                       |
| -------------------- | ------------------------------------------------------------------------------- |
| `optional` (default) | a review covering the head is honoured if present; its absence is not a blocker |
| `required`           | a review covering the head **must** exist, else `needs-decision`                |
| `off`                | reviews are never fetched — no API calls, no review signal of any kind          |

`optional` is the default deliberately. `required` reads safer and is what wedges a fresh adoption: a repo with no review workflow still gets the `claude[bot]` default for `review.bot`, so nothing ever matches, every PR parks, and the printed reason ("no review of the current head") is indistinguishable from a review bot that is merely broken. Under `optional` the gate is still CI plus the adversarial rubric grader, which never wrote the code. `hamster doctor` fails the `review gate` check when `mode = required` and the configured reviewer has never posted on the repo — that turns the wedge into a diagnosis.

A `CHANGES_REQUESTED` review from **any** login blocks under both `required` and `optional`, body text aside: a human will not write `(high)` unprompted, so their objection would otherwise parse as clean prose. It is not aged out against the head — GitHub holds that state until the reviewer re-reviews, which is exactly what it means. Latest position per reviewer wins, so a later `APPROVED` from the same person clears it. **`off` cannot see it**, since it makes no review calls at all; that is the cost of the mode, and branch protection is the backstop if a human veto must hold regardless of loop config.

A `[[human]]` rule has a `name` and fires on changed **paths** (case-insensitive regex against the PR's files) and/or issue **labels** (case-insensitive exact match) — either hit parks the PR. At least one path-based rule is required, so a schema migration can never auto-merge by omission; the canonical config is a `prod-migration` rule on `(^|/)(migrations|drizzle)/`, with optional extras like a `labels = ["security", "auth", "payments"]` rule. Label-triggered rules are known at selection time, so `plan` prints "will park for human (<rule>)" against the affected issues before anything runs.

**`blockingReview` is the arm most likely to be silently broken in your repo.** It greps your review bot's comment for severity markers. If your review workflow asks for freeform prose, no finding ever carries a marker, `blockingReview` is always 0, and the gate reads every review — including one flagging real problems — as approval. Verify it empirically before trusting it; `reference/adoption-checklist.md` has the exact test.

That verification matters just as much under `optional` as under `required`, and it is easy to assume otherwise. `optional` relaxes whether a review must _exist_; it does not relax what a review that does exist is allowed to say. A reviewer emitting untagged prose is equally invisible in both modes.

## When something goes wrong

| symptom                                             | first move                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| issue never appears in the queue                    | `plan` — read its skip reason                                                             |
| legitimate issue skipped as injection               | check the title for `act as`, `new task:` and similar; the tripwire is deliberately blunt |
| everything blocked at once                          | a run-fatal precondition leaked into per-issue blame; check preflight, then `reconcile`   |
| item stuck In Progress with nothing running         | `reconcile`                                                                               |
| burst of instant failures, ~1/min, tiny transcripts | session quota exhaustion, not bugs — see reference                                        |
| board reads fail but `gh issue`/`gh pr` work fine   | GraphQL quota, not a broken board: `hamster doctor` prints both pools and the reset time  |
| driver died mid-gate with a PR open                 | do **not** re-run that issue; finish the gate by hand                                     |

A failure about **this** issue blocks this issue. A precondition that fails identically for every item — docker, gh auth, a missing runner binary, a broken setup script — is **run-fatal**: abort, release the claim, touch nothing else. If a whole curated queue went Blocked in under a minute, that taxonomy is what broke, not the sandbox.

## Reference

- `reference/adoption-checklist.md` — the pre-first-run checklist, including the silent-failure items
- `reference/operating-lessons.md` — the paid-for lessons: git safety, review-loop bounds, quota signatures, parallel-wave hazards

Full CLI surface: `hamster --help`, per-command detail (flags, exit codes, `--json` shape): `hamster <command> --help`. Config: `hamsterwheel.example.toml`. Architecture: `docs/design.md`.
