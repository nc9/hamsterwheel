# hamsterwheel 🐹

> An autonomous issue loop for coding agents: you sleep, the hamster runs the wheel.

## What it will be

hamsterwheel is two pieces that let a coding agent grind through a backlog unattended, overnight, without setting your laptop on fire or merging garbage:

- **A sandbox runner** — spins up OS-isolated, headless agent sessions in Docker so an autonomous agent can hack on your repo without touching your host, your credentials, or your sanity.
- **A merge-gate kit** — a pure, heavily-tested set of functions that decide whether a branch is allowed to merge: CI gating, rubric/CI reconciliation, screening agent output for prompt injection, classifying implement-outcomes, and salvaging work-in-progress so nothing the hamster did overnight is ever lost.

## Status

**Sandbox + gate are ported and tested. The loop driver is next.** 🐹

The two load-bearing pieces are in place: `@hamsterwheel/sandbox` (the OS-isolation docker runner, image, and entrypoint) and `@hamsterwheel/gate` (the pure, heavily-tested merge-gate kit). The `hamsterwheel` CLI links both, but the loop driver that actually spins the wheel — claim an issue, run a headless session, gate the PR — isn't wired yet, so every subcommand still answers "not yet implemented". Come back after a few more commits.

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
