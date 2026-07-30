# hamsterwheel 🐹

> An autonomous issue loop for coding agents: you sleep, the hamster runs the wheel.

## What it is

hamsterwheel turns an issue backlog into reviewed, merged PRs, unattended: issues in, deploys out. You do engineering management on a board; the loop does everything after `Ready`. The design rule throughout: use the model for judgement, use code for decisions.

- **The board is the control plane.** A GitHub Projects v2 board and an issue contract (acceptance criteria, priority, size, `loop:*` labels). Only `Ready` is eligible, and `hamster plan` prints why every excluded issue was skipped, because silent eligibility failure is the worst failure mode in a system nobody is watching.
- **Cold headless sessions, not a long chat.** Each issue gets a fresh session with a tight prompt in a persistent worktree **lane** (warm `node_modules`, `.worktreeinclude` copies your env files in), then exits. Nothing accumulates, and the loop process holds no important state: the issue is the spec, the board is the claim, the PR is the work.
- **The merge gate is code, not a prompt.** A pure, heavily-tested decision over CI, `[[human]]` rules (migrations, security, payments: parked for a human, never auto-merged), blocking review findings, and an adversarial read-only rubric grade of the acceptance criteria. Every heuristic errs toward blocking. Run-fatal errors abort the run instead of burning the queue.
- **Model and effort tiering saves real money.** Runner, model and effort resolve per issue (label, then config, then heuristic), independently for implement and review, across `claude`, `codex` and `opencode`. Small mechanical work goes to cheap models; routing right cuts token spend on the order of 80%.
- **Nothing is ever lost, nothing is trusted.** Dirty worktrees are salvaged to WIP branches before any teardown; branch deletion is from classified lists, never globs. Issue text is untrusted: injection-screened, fenced, and optionally run inside a Docker sandbox that mounts only the worktree.
- **Releases stay human.** `hamster release` derives the notes from git (commits since the last tag, PRs, closed issues), cuts the tag + GitHub Release, and archives the shipped Done items so the board stays a queue. It is the one mutation that is always human-invoked.

## Install

Works under **node or bun**; the published artifact is node-targeted ESM with no bun dependency.

```bash
npm i -g hamsterwheel       # or: bun add -g hamsterwheel
hamster doctor
```

Needs `git`, `gh` (authenticated, with the `project` scope), and at least one agent CLI on PATH (`claude`, `codex`, or `opencode`). `docker` only for `--sandbox`. `hamster doctor` tells you which of those are missing, and reports your GitHub API quota — board traffic is GraphQL-only, and an exhausted GraphQL budget fails at the board read while every `gh issue`/`gh pr` command keeps working, which reads as a broken board rather than a wall that clears on a timer.

Install the operator skill so your agent knows how to adopt and drive the loop:

```bash
npx skills add nc9/hamsterwheel
```

(or copy `skills/hamsterwheel/` into your repo's `.claude/skills/` by hand).

## Getting started

First, make your repo worktree-ready: sessions run in lanes, and worktrees are born without git-ignored files. List anything a session needs (env files, local config) in a `.worktreeinclude` at the repo root, gitignore-style globs, copied into each lane before a session runs. `hamster doctor` warns about env-style files you haven't covered, and `hamster init` offers to scaffold it.

```bash
hamster doctor           # what's ready, what's missing
hamster init --dry-run   # show every mutation init would make
hamster init             # provision board + labels, write the config
hamster plan             # read-only: queue + resolved runner/model/effort
hamster once --execute   # one issue, claim -> PR -> gate -> merge/Blocked
hamster run  --execute   # until the Ready queue is empty
```

`plan`, `reconcile`, `prune` (without `--delete`) and `release` (without `--execute`) never mutate GitHub or the board. `once`/`run` mutate only with `--execute`. Start a new repo on `--pr-only`: the identical pipeline, stopped at the open PR, so you inspect real output before the merge path runs unsupervised.

When a version ships:

```bash
hamster release                        # preview: notes, suggested bump, archive plan
hamster release --tag v0.5.0 --execute # tag + GitHub Release + archive the shipped Done items
```

The CLI is agent-first: nothing is interactive (every input is a flag; `init` prompts only on a TTY, `--yes`/`--dry-run` otherwise), every command takes `--json` (one JSON object on stdout, human progress on stderr), and `hamster <command> --help` documents each command's flags, exit codes, and JSON shape. Flags are validated per command; a flag on the wrong command errors instead of being silently ignored.

## Status

**The loop driver is wired.** 🐹 `init` · `doctor` · `plan` · `once` · `run` · `triage` · `reconcile` · `prune` · `release` all do real work.

Everything repo-specific lives in `hamsterwheel.toml` (see `hamsterwheel.example.toml`); nothing about a particular board, review bot, human-review rules or model policy is hardcoded. That includes how much a server-side PR review counts: `review.mode` is `optional` by default, on the view that CI is the essential gate and the reviewing may well have happened locally. Set it to `required` if a review bot's verdict should be load-bearing, or `off` to skip reviews entirely. Not yet: wave/parallel mode, post-merge deploy+smoke hooks, deny-by-default sandbox egress.

## Using it from a coding agent

`skills/hamsterwheel/` is a [skill](https://code.claude.com/docs/en/skills) covering adoption, the issue
contract, label policy, and what to do when the loop skips or blocks something. Install it with
`npx skills add nc9/hamsterwheel`, or copy the directory into your repo's `.claude/skills/`.

It carries two reference files worth reading even by hand: `reference/adoption-checklist.md` (the
pre-first-run checks, four of which fail _silently_, one of which defeats the merge gate outright) and
`reference/operating-lessons.md` (git safety, review-loop bounds, quota signatures, parallel-wave
hazards).

## Workspace layout

```
hamsterwheel/
  apps/
    cli/            # the `hamster` CLI + loop driver (bun)
  packages/
    sandbox/        # @hamsterwheel/sandbox - OS-isolated docker session runner
    gate/           # @hamsterwheel/gate - pure, tested merge-gate + selection + routing policy
    runners/        # @hamsterwheel/runners - claude/codex/opencode argv, validation, output parsing
    config/         # @hamsterwheel/config - hamsterwheel.toml schema + loader
  skills/
    hamsterwheel/   # agent skill: how to adopt and operate the loop, + the paid-for lessons
```

## Development

Everything runs on [bun](https://bun.sh):

```bash
bun install          # install the workspace
bun test             # run all tests
bun run lint         # oxlint
bun run format       # oxfmt
bun apps/cli/src/index.ts --help
```

The source is written against node APIs on purpose, so the same code runs under both runtimes with no shim. A CI job installs the packed tarball and runs it under node to keep it that way; a stray `Bun.file` would break every npm consumer and would otherwise only surface after a release.

## License

MIT © 2026 Nik Cubrilovic
