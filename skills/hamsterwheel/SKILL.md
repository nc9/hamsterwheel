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

Then, before the first batch, work `reference/adoption-checklist.md`. Several of its items fail
silently rather than loudly, and one of them defeats the merge gate entirely.

Two settings worth deciding at adoption rather than discovering:

- **`commit_signoff = true`** if the repo enforces DCO. It is checked per commit, and the failure
  names the commit rather than your config, so without it every PR fails a gate that reads like an
  agent mistake. The trailer must match the commit's mailmap-applied author — see the checklist.
- **`review.mode`** — `optional` unless the repo genuinely has a review bot that posts on every PR.
  `required` against a repo with no reviewer parks every PR forever, with a reason indistinguishable
  from a broken reviewer.

## One repo per loop

**The loop works issues and opens PRs in the same repo, and there is no way to split them.**
`buildQueue` drops any board item whose `content.repository` is not `cfg.repo`, and `cfg.repo` is
also what every `gh pr` call targets. `source_repos` widens _triage_ only — it decides what
`triage --sync` folds onto the board, never what the loop is allowed to work.

So if the code for an issue lives somewhere else — a submodule, a split-out public repo, a sibling
package repo — that issue is not workable by this loop, however well written it is. The fix is a
second config: a standalone clone of the other repo, its own board, its own `hamsterwheel.toml`.

Two things bite when you do that, and neither is obvious until the first batch:

- **Acceptance criteria must be checkable in the repo the loop runs against.** The rubric grader is a
  read-only session inside that one worktree. A criterion naming a file that lives in the _other_
  repo can never be satisfied — the grader looks, does not find, and fails the issue. Strip those
  criteria out and make them a follow-up chore in the repo that owns the file.
- **Derived files in the other repo go stale on every merge.** Where repo A commits something
  generated from repo B's source — a catalog, a manifest, a type bundle, a pinned pointer — every
  merge in B leaves A's copy wrong and A's CI red until someone regenerates it. That reconciliation
  is a separate, batched, human-run chore. Plan for it rather than discovering it as a red main.

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

Criteria naming files **outside the loop's repo** are a different matter, and they fail every time — see "One repo per loop" above.

**`Depends on #N` must be literal.** The dependency is parsed out of the body by pattern, so a prose
sentence — "depends on the classification added by the other issue" — is not a dependency, it is a
comment. The loop will happily start the dependent issue first, and on related work that usually
means two sessions editing the same seam. `plan` prints `blocked by open dep(s) #N` for a dependency
it actually parsed; if you do not see that line, it did not.

Also required for eligibility: a priority label (`P0`–`P3`) and a size label (`size: XS`–`size: XL`). Unsized defaults to expensive, which is the right way round.

## Working alongside people

**An issue a person has claimed is not the loop's to take.** The community guard (`community_guard`,
on by default) parks an issue as `Blocked: needs-human` on any of three signals: a non-bot assignee, a
comment from anyone outside the org, or the `hands_off_label` (`loop:hands-off`).

On a public repo the **comment** is the signal that matters. A drive-by contributor has no write
access, so they cannot self-assign — "I'd like to work on this" in a comment is the only way they can
call an issue, and it is the one thing a loop reading title/body/labels is blind to. That blindness
has a cost that is easy to underrate: a contributor commented with an accurate plan of attack, and
twenty-two minutes later the loop claimed the same issue and merged essentially that plan inside the
hour. Nothing was broken. The work was good. The contributor was simply gone.

The check is deliberately blunt — a bare "+1" blocks the issue. Waving it through costs you seconds;
missing one costs someone their afternoon and the project a contributor.

**This changes what you must do before putting a public issue on the board.** Read the comments
yourself. `plan` reports the guard's verdict per issue, so a blocked-for-human line is the loop
telling you a conversation is already happening on that issue and you should be the one having it.

The loop deliberately posts **no comment** when it parks an issue this way. You need to know; the
person who just volunteered does not need a bot replying to them.

On a private board every commenter is in-org, so the guard is silent and costs nothing. Leave it on.

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
- **`once`/`run` `--json`** replays the structured run-log events (`claim`, `pr-open`, `gate`, `merged`, `blocked`, `failed`, …) plus a summary with counts — the same events written to the run log. It emits **once, at exit**; for a live feed use `--stream`, and to check on a run you did not spawn use `hamster status` (see Monitoring a run).
- **`init` never prompts off a TTY**: pass `--yes` to apply or `--dry-run` to preview (mandatory with `--json`); `--project-title <t>` overrides the default board title "<repo-name> Loop" (the repo name is in the default because most orgs run multiple boards).

## Lanes: how sessions get a working copy

Sessions never run in your checkout. Each issue runs in a **lane** — a persistent git worktree (`~/.hamsterwheel/worktrees/<repo>/lane-0`…) reused across issues so `node_modules` and build caches stay warm (the per-issue cost is an incremental setup, not a cold one).

`worktree_lanes` sizes the pool AND sets how many issues run at once:

- **`1` (default)** — the serial loop: one issue start→merge→next, no locks allocated.
- **`>1` — wave mode.** Implement sessions overlap, which is where the wall-clock is (12-60 min each). Shared-repo git operations (`fetch`, `worktree add/prune`, checkout) take a git lock, and the final `gh pr merge` takes a merge lock, so those stay ordered; the parallelism is in the sessions. Each log line is tagged `[L<n>]`. `once` always runs a single lane regardless.

Sizing: a lane costs disk plus one cold `scripts.setup`, so match it to what the machine can genuinely run concurrently. GitHub API quota is consumed per in-flight pipeline, and the pre-claim quota floor scales with lane count accordingly.

**Some batches must stay serial no matter how many lanes the machine can afford.** Lane count is a
property of the _work_, not only of the hardware:

- **Every issue regenerates the same derived file** — a generated catalog, a committed lockfile, a
  migration sequence number. Whoever merges second invalidates the first PR's committed copy and
  fails its drift guard. N lanes buys N-1 conflicts, not N× throughput.
- **Branch protection requires up-to-date-with-base.** Merging one PR puts every open sibling
  `BEHIND`; each then needs `gh pr update-branch`, which re-triggers its whole CI run. The batch
  serialises anyway, just with more wasted CI.

Neither is visible in `plan` — it ranks issues, it does not know two of them touch the same generated
artifact. Sizing lanes is a judgement about the batch, made before you start it.

**Never run two driver processes against one board.** The claim guard is a read-then-write on the Owner field, not a compare-and-set (Projects v2 has no conditional field update). One process's lanes coordinate through a shared cursor; two processes do not, and will double-claim. Ordering merges is also not a merge queue: two individually-green PRs can still break the base when both land, because neither was tested against the other's result.

After every acquire hamster runs the configured setup script — `[scripts]` `setup` in `hamsterwheel.toml` (Conductor-style lifecycle table; `run`/`archive`/`maintenance` are reserved). It is argv-exec'd with **no shell** (pipes/`&&` belong in a repo script the config points at) and receives context env vars: `HAMSTER_WORKSPACE_PATH` (lane dir), `HAMSTER_WORKSPACE_NAME` (`lane-0`), `HAMSTER_ROOT_PATH` (primary checkout), `HAMSTER_LANE_COLD` (`1` fresh worktree / `0` warm reuse), `HAMSTER_ISSUE`, `HAMSTER_RUN_ID`. No `setup` configured → no setup step. The old `install_cmd` key is a hard config error. `hamster init` pre-fills `setup` from existing conventions when it can (`conductor.json` `scripts.setup`, `.cursor/environment.json` `install`, a `scripts/setup.sh`, or the lockfile's package manager) — detection happens only at init; the runtime obeys the explicit config alone.

A claim **resumes** the newest salvage branch for that issue rather than starting clean, and the
implement session is told it is resuming and asked to diff against the base before adding to it.
Salvage nothing ever reads back just means a killed run's work is re-derived from scratch on every
retry. Only claim-time salvage (`<prefix>/<n>-wip-loop-<ts>-<n>`) is eligible: the lane's own
leftover sweep names the _previous_ occupant's work after the _incoming_ issue, so resuming that
shape would graft one issue's abandoned work onto another's branch.

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

## Monitoring a run

**If you launched the loop, you are responsible for watching it.** A run is minutes to hours of
unattended work that mutates a board and merges code; "started it and walked away" is not operating
it. There are three signals, and they answer different questions.

### `hamster status` — what is happening right now

```bash
hamster status                       # human: phase per lane, counts, seconds since heartbeat
hamster status --json | jq -r .state # idle | running | stale | ended
```

Read-only, touches no network or board, safe to poll on any cadence. It reads a per-repo status file
the run rewrites atomically, so a reader never catches a torn write.

**The state you care about is `stale`.** The run log cannot tell you a run has died — a dead process
simply stops appending, which is identical to a slow one. `status` heartbeats through the long waits,
so `stale` means the heartbeat aged out: the run died, or a phase is wedged. It exits 1 in that
state, so `hamster status --json >/dev/null || alert` is a complete watchdog. `ended` is distinct
from `stale` — a finished run stamps `endedAt`, so "finished 20m ago" never reads as "died 20m ago".

Watch the pipe, though: `hamster status | tail` reports the exit code of `tail`, so a stale run comes
back 0 and a watchdog built that way never fires. Redirect instead of piping, or check `PIPESTATUS`.

Each lane reports its `phase` (`claiming`, `implementing`, `ci-wait`, `review-fix`, `rubric`,
`merging`) and the time it entered it. A phase's `since` is entry time, not last touch, so a lane
stuck 50 minutes in `ci-wait` is visible even while the run is healthily heartbeating.

### `--stream` — a live event feed

```bash
hamster run --execute --stream       # one JSON object per line, as each event happens
```

For a parent that spawned the process and holds the pipe. Same shape as the run-log lines. Plain
`--json` is a post-mortem: it buffers every event and emits one object at exit, which is useless
while the run is in flight.

### The run log — why something happened

`~/.hamsterwheel/runs/<owner>-<repo>/<ts>.jsonl`, **per repo** — with more than one loop, a flat
directory makes "the current run" unfindable, and picking by mtime silently returns the other repo's
run. Every line carries the run id, and `start` carries the repo.

This is the post-mortem surface, covered in `reference/operating-lessons.md`. Reach for it after the
fact, not to answer "is it alive".

### What to actually do while it runs

Poll `status`. On `stale`, stop and diagnose rather than relaunching — a second driver against one
board double-claims. Read the gate's reason on anything that parks: `ci-red` is a defect in the PR,
`ci-timeout` is not, `needs-human` means a tripwire fired and the batch may now contain merged work
that depends on the parked change. When the queue drains, reconcile anything the run left In Review.

**A dead run leaves its claim behind, and the claim is what blocks a restart.** `hamster reconcile`
lists what is in flight; once you have decided a run is really gone, `hamster reconcile --release <n>`
puts the issue back. Use the flag rather than editing the board by hand: the reset has two halves
(status → Ready **and** clear the Owner), and an item left Ready with a live-looking Owner is skipped
by the claim guard on every future run — the issue leaves the queue permanently, and nothing reports
it. `reconcile` also flags Done items whose issue was reopened, which is the same class of drift from
the other direction.

## The merge gate

The merge decision is a pure function over its signals, evaluated in a fixed order:

```
CI → human-review rules → changes-requested → review provenance* → blocking review findings → rubric
                                              *only when review.mode = "required"
```

No model is ever asked "should this merge?" Models grade the rubric, which is a judgement call over English. Reconciling that grade with CI, human-review rules and review findings is deterministic tested code.

Never auto-merged regardless of how green things look: anything matching a `[[human]]` rule in `hamsterwheel.toml` (parked as `needs-human`, with the fired rule names in the reason), anything carrying a high or critical review finding, and anything a reviewer has requested changes on. Nits don't block.

**`ci-red` and `ci-timeout` are different answers.** Red means the suite failed — a defect in the PR.
Timeout means CI never concluded inside `ci_timeout_ms` — a fact about runner-fleet depth that says
nothing about the code. They are separate reasons so a slow queue does not send someone to debug a
failure that never happened. The board option for `ci-timeout` defaults to whatever `ci_red` resolves
to, so an existing board keeps working until you give it its own option.

**A parked PR does not park what depends on it.** A `[[human]]` rule holds _that_ PR; the loop
carries on merging everything else, including work that assumes the parked change already landed.
The canonical shape is a schema migration held for a human while the code reading the new columns
merges straight past it, leaving deploy red until someone notices. The loop cannot see that edge —
when a human rule fires, resolve it before the next batch rather than at the end of the week.

**Path-based human rules fire at the gate; label-based ones at selection.** A `paths` rule can only
match once a diff exists, so it is evaluated _after_ the implement session has run and been paid for.
If you already know from the issue that a human must see it, a `labels` rule parks it before any
session spawns, and `plan` says so up front.

**Draft PRs cannot be merged.** The gate marks a draft ready before merging, because that check is
the very last thing GitHub evaluates — a draft otherwise throws away a full passing gate at the final
API call. Session prompts are told to open PRs ready; if you customise them, keep that.

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
| blocked `ci-timeout`                                | CI did not conclude, the suite did not fail — re-run the gate or raise `ci_timeout_ms`    |
| blocked `dep-open`                                  | working as intended; `plan` names the open dependency                                     |
| "is it still running?"                              | `hamster status` — `stale` means died or wedged; exits 1, so it works as a watchdog       |
| "why did that batch underperform?"                  | read the run log jsonl — the board shows state, the run log shows cause                   |

A failure about **this** issue blocks this issue. A precondition that fails identically for every item — docker, gh auth, a missing runner binary, a broken setup script — is **run-fatal**: abort, release the claim, touch nothing else. If a whole curated queue went Blocked in under a minute, that taxonomy is what broke, not the sandbox.

## Reference

- `reference/adoption-checklist.md` — the pre-first-run checklist, including the silent-failure items
- `reference/operating-lessons.md` — the paid-for lessons: git safety, review-loop bounds, quota signatures, parallel-wave hazards

Full CLI surface: `hamster --help`, per-command detail (flags, exit codes, `--json` shape): `hamster <command> --help`. Config: `hamsterwheel.example.toml`. Architecture: `docs/design.md`.
