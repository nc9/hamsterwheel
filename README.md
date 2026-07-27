# hamsterwheel 🐹

> An autonomous issue loop for coding agents: you sleep, the hamster runs the wheel.

## What it is

hamsterwheel is a small set of pieces that let a coding agent grind through a backlog unattended, overnight, without setting your laptop on fire or merging garbage:

- **A sandbox runner** — spins up OS-isolated, headless agent sessions in Docker so an autonomous agent can hack on your repo without touching your host, your credentials, or your sanity.
- **A config-driven loop driver** — reads a GitHub Projects v2 board, claims the top Ready issue, runs a headless implement session in a worktree, gates the PR, and merges or blocks with a reason.
- **A merge-gate kit** — a pure, heavily-tested set of functions that decide whether a branch is allowed to merge: CI gating, rubric/CI reconciliation, screening agent output for prompt injection, classifying implement-outcomes, and salvaging work-in-progress so nothing the hamster did overnight is ever lost.

## Status

**The loop driver is wired.** 🐹 `init` · `doctor` · `plan` · `once` · `run` · `triage` · `reconcile` · `prune` · `release` all do real work.

Everything repo-specific lives in `hamsterwheel.toml` (see `hamsterwheel.example.toml`); nothing about a particular board, review bot, human-review rules (migration paths, sensitive labels) or model policy is hardcoded. That includes how much a server-side PR review counts: `review.mode` is `optional` by default, on the view that CI is the essential gate and the reviewing may well have happened locally — set it to `required` if a review bot's verdict should be load-bearing, or `off` to skip reviews entirely. Not yet: wave/parallel mode, post-merge deploy+smoke hooks, deny-by-default sandbox egress.

## Quick start

First, make your repo worktree-ready: sessions run in persistent worktree **lanes**, and worktrees are born without git-ignored files. List anything a session needs (env files, local config) in a `.worktreeinclude` at the repo root — gitignore-style globs, copied into each lane before a session runs. `hamster doctor` warns about env-style files you haven't covered, and `hamster init` offers to scaffold it.

```bash
bun install
bun apps/cli/src/index.ts doctor          # what's ready, what's missing
bun apps/cli/src/index.ts init --dry-run  # show every mutation init would make
bun apps/cli/src/index.ts init            # provision board + labels, write the config
bun apps/cli/src/index.ts plan            # read-only: queue + resolved runner/model/effort
bun apps/cli/src/index.ts once --execute  # one issue, claim -> PR -> gate -> merge/Blocked
bun apps/cli/src/index.ts run --execute   # until the Ready queue is empty
```

`plan`, `reconcile`, `prune` (without `--delete`) and `release` (without `--execute`) never mutate GitHub or the board. `once`/`run` mutate only with `--execute`.

When a version ships, `hamster release --tag vX.Y.Z --execute` derives the notes from git (commits since the last tag → PRs → closed issues), creates the tag + GitHub Release, and archives the shipped Done items — the board stays a queue; the history lives in the release. Releases are the one mutation that is always human-invoked.

## Workspace layout

```
hamsterwheel/
  apps/
    cli/            # the `hamster` CLI + loop driver (bun)
  packages/
    sandbox/        # @hamsterwheel/sandbox — OS-isolated docker session runner
    gate/           # @hamsterwheel/gate — pure, tested merge-gate + selection + routing policy
    runners/        # @hamsterwheel/runners — claude/codex/opencode argv, validation, output parsing
    config/         # @hamsterwheel/config — hamsterwheel.toml schema + loader
  skills/
    hamsterwheel/   # agent skill: how to adopt and operate the loop, + the paid-for lessons
```

## Using it from a coding agent

`skills/hamsterwheel/` is a [skill](https://code.claude.com/docs/en/skills) covering adoption, the issue
contract, label policy, and what to do when the loop skips or blocks something. Point your agent at it,
or copy the directory into your repo's `.claude/skills/`.

It carries two reference files worth reading even by hand: `reference/adoption-checklist.md` (the
pre-first-run checks, four of which fail _silently_ — one of them defeats the merge gate outright) and
`reference/operating-lessons.md` (git safety, review-loop bounds, quota signatures, parallel-wave
hazards).

## Development

Everything runs on [bun](https://bun.sh):

```bash
bun install          # install the workspace
bun test             # run all tests
bun run lint         # oxlint
bun run format       # oxfmt
bun apps/cli/src/index.ts --help
```

## License

MIT © 2026 Nik Cubrilovic

## Install

Works under **node or bun** — the published artifact is node-targeted ESM with no bun dependency.

```bash
npm i -g hamsterwheel       # or: bun add -g hamsterwheel
hamster doctor
```

Needs `git`, `gh` (authenticated, with the `project` scope), and at least one agent CLI on PATH. `docker` only for `--sandbox`. `hamster doctor` tells you which of those are missing.

The CLI is agent-first: nothing is interactive (every input is a flag; `init` prompts only on a TTY, `--yes`/`--dry-run` otherwise), every command takes `--json` (one JSON object on stdout, human progress on stderr), and `hamster <command> --help` documents each command's flags, exit codes, and JSON shape. Flags are validated per command — a flag on the wrong command errors instead of being silently ignored.

The source is written against node APIs on purpose, so the same code runs under both runtimes with no shim. A CI job installs the packed tarball and runs it under node to keep it that way — a stray `Bun.file` would break every npm consumer and would otherwise only surface after a release.
