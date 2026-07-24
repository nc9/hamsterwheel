# hamsterwheel 🐹

> An autonomous issue loop for coding agents: you sleep, the hamster runs the wheel.

## What it will be

hamsterwheel is two pieces that let a coding agent grind through a backlog unattended, overnight, without setting your laptop on fire or merging garbage:

- **A sandbox runner** — spins up OS-isolated, headless agent sessions in Docker so an autonomous agent can hack on your repo without touching your host, your credentials, or your sanity.
- **A merge-gate kit** — a pure, heavily-tested set of functions that decide whether a branch is allowed to merge: CI gating, rubric/CI reconciliation, screening agent output for prompt injection, classifying implement-outcomes, and salvaging work-in-progress so nothing the hamster did overnight is ever lost.

## Status

**Freshly bootstrapped. Nothing works yet.** 🐹

The wheel is installed, the hamster has been hired, but no one has taught it to run. Every subcommand currently answers with a polite "not yet implemented" and goes back to sleep. Come back after a few more commits.

## Workspace layout

```
hamsterwheel/
  apps/
    cli/            # the `hamsterwheel` CLI (bun, plain argv for now)
  packages/
    sandbox/        # @hamsterwheel/sandbox — OS-isolated docker session runner
    gate/           # @hamsterwheel/gate — pure, tested merge-gate kit
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

## License

MIT © 2026 Nik Cubrilovic
