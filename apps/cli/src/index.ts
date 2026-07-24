#!/usr/bin/env bun

import { mergeDecision } from "@hamsterwheel/gate";
import { buildSandboxArgs } from "@hamsterwheel/sandbox";

import pkg from "../package.json";

/** "ready" once a package's real export links from the workspace, else "missing". */
const wired = (exported: unknown): string => (typeof exported === "function" ? "ready" : "missing");

/** Subcommands the wheel will eventually spin. None are live yet. */
export const PLANNED_COMMANDS = ["plan", "once", "run", "triage", "prune"] as const;
type PlannedCommand = (typeof PLANNED_COMMANDS)[number];

function isPlannedCommand(value: string): value is PlannedCommand {
  return (PLANNED_COMMANDS as readonly string[]).includes(value);
}

function printVersion(): void {
  console.log(pkg.version);
}

function printHelp(): void {
  console.log(`🐹 hamsterwheel v${pkg.version}
An autonomous issue loop for coding agents: you sleep, the hamster runs the wheel.

Usage:
  hamsterwheel <command> [options]

Commands (all not yet implemented):
  plan     sketch the overnight run from your open issues
  once     send a single issue around the wheel
  run      run the loop until the backlog is clear
  triage   sort and label the backlog
  prune    clean up stale branches and worktrees

Flags:
  --version, -v   print the version and exit
  --help,    -h   show this help

status: sandbox + gate ported; the loop driver lands next.
engines wired -> sandbox:${wired(buildSandboxArgs)} gate:${wired(mergeDecision)}`);
}

/**
 * Parse argv and act. Returns the intended process exit code so this stays a
 * pure-ish function the tests can drive without tearing down the process.
 */
export function main(argv: string[]): number {
  const command = argv[2];

  if (command === "--version" || command === "-v") {
    printVersion();
    return 0;
  }

  if (command === undefined || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (isPlannedCommand(command)) {
    console.log("🐹 not yet implemented");
    return 0;
  }

  console.error(`unknown command: ${command}\nrun \`hamsterwheel --help\` to see what's planned.`);
  return 1;
}

if (import.meta.main) {
  process.exit(main(process.argv));
}
