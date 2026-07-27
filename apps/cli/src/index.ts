#!/usr/bin/env bun
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

import {
  CONFIG_FILENAME,
  type Config,
  ConfigError,
  findConfig,
  loadConfig,
} from "@hamsterwheel/config";

import pkg from "../package.json";
import { type ParsedArgs, parseArgs } from "./args.ts";
import { loadBoardCtx } from "./board.ts";
import {
  type CommandDeps,
  plan,
  reconcile,
  runTriagePasses,
  triage,
  workQueue,
} from "./commands.ts";
import { doctor } from "./doctor.ts";
import { RunFatalError, runFatalReason } from "./errors.ts";
import { Gh } from "./gh.ts";
import { init } from "./init.ts";
import { preflight } from "./preflight.ts";
import { runPrune } from "./prune.ts";
import { createRunLog, makeRunId } from "./runlog.ts";

const log = (...m: unknown[]) => console.log(...m);

export const HELP = `🐹 hamsterwheel v${pkg.version}
An autonomous issue loop for coding agents: you sleep, the hamster runs the wheel.

Usage:
  hamsterwheel <command> [options]

Commands:
  init       verify prerequisites, provision the board + labels, write ${CONFIG_FILENAME}
  doctor     re-run just the prerequisite checks
  plan       read-only: the eligible queue, skip reasons, and the resolved runner/model/effort
  once       one issue end to end (claim → PR → gate → merge / Blocked)
  run        loop \`once\` until the Ready queue is empty (serial)
  triage     PM doctor + the auto-block passes (missing criteria, suspected injection)
  reconcile  report in-flight items with no live session behind them
  prune      classify and clean up stale local WIP salvage branches

Flags:
  --execute          do real work (once/run mutate the board only with this)
  --issue <n>        target a specific Ready+eligible issue
  --pr-only          stop at the open PR: skip the merge gate (supervised runs)
  --sandbox          OS-isolate the sessions in a container
  --bypass           claude: full bypassPermissions instead of the scoped allow-list (loud, supervised)
  --sync             triage: add open issues missing from the board as Draft
  --delete           prune: actually delete (default is a dry-run plan)
  --yes / --dry-run  init: non-interactive / print-only
  --config <path>    use a specific ${CONFIG_FILENAME}
  --version, --help  version / help`;

/** Resolve the config for a board-backed command, or explain why we can't. */
const resolveConfig = async (args: ParsedArgs): Promise<Config> => {
  const path = args.configPath ?? (await findConfig(process.cwd()));
  if (!path)
    throw new ConfigError([
      `no ${CONFIG_FILENAME} found from ${process.cwd()} upward — run \`hamsterwheel init\``,
    ]);
  return loadConfig(path);
};

export const main = async (argv: string[]): Promise<number> => {
  const args = parseArgs(argv);
  if (args.unknown.length) {
    console.error(
      `unknown or malformed argument(s): ${args.unknown.join(", ")}\nrun \`hamsterwheel --help\`.`,
    );
    return 1;
  }
  if (args.version) {
    log(pkg.version);
    return 0;
  }
  if (args.help || args.command === null) {
    log(HELP);
    return 0;
  }

  // Checked before anything reads config or touches GitHub: a `run` typed without --execute should cost
  // nothing and change nothing.
  if (args.command === "run" && !args.execute) {
    log(
      "⚠ `run` requires --execute to loop — use `once` for a single dry pass, or `plan` to inspect.",
    );
    return 1;
  }

  const gh = new Gh();
  if (args.command === "init")
    return init({ cwd: process.cwd(), yes: args.yes, dryRun: args.dryRun, log, gh });
  if (args.command === "doctor") return doctor({ cwd: process.cwd(), log, gh });

  const cfg = await resolveConfig(args);

  // prune needs no board — it runs standalone, ahead of any project lookup.
  if (args.command === "prune") {
    log(`🐹 prune${args.delete ? " (--delete)" : " (dry run)"}`);
    await runPrune(gh, cfg, { delete: args.delete, log });
    return 0;
  }

  const ctx = await loadBoardCtx(gh, cfg);
  const readOnly = args.command === "plan" || args.command === "reconcile";
  const deps: CommandDeps = {
    gh,
    cfg,
    ctx,
    log,
    runLog: createRunLog({ dir: `${process.env.HOME}/.hamsterwheel/runs`, runId: makeRunId(0) }),
    prOnly: args.prOnly,
    sandbox: args.sandbox,
    bypassPermissions: args.bypass,
  };
  log(
    `🐹 hamsterwheel — ${cfg.repo} · project #${ctx.projectNumber} · ${args.command}${args.execute ? " (--execute)" : ""}`,
  );
  if (!readOnly) deps.runLog.append("start", { command: args.command, execute: args.execute });

  switch (args.command) {
    case "plan":
      await plan(deps);
      return 0;
    case "reconcile":
      await reconcile(deps);
      return 0;
    case "triage":
      await triage(deps, args.sync);
      // The auto-block passes MUTATE the board, so they stay behind --execute like every other write.
      if (args.execute) await runTriagePasses(deps);
      else log("\n(read-only: pass --execute to apply the auto-block passes)");
      return 0;
    default: {
      if (args.bypass && !args.sandbox)
        log(
          "⚠ --bypass without --sandbox: the session gets unrestricted tools with no isolation boundary.",
        );
      // Refuse to START on a precondition that would fail identically for every item. Discovering it
      // per-issue is how a whole curated Ready queue got burned into Blocked in under a minute.
      if (args.execute) preflight({ cfg, sandbox: args.sandbox });
      if (args.execute) await runTriagePasses(deps);
      try {
        await workQueue(deps, {
          loop: args.command === "run",
          execute: args.execute,
          issue: args.issue,
        });
      } catch (e) {
        const fatal = runFatalReason(e);
        if (!fatal) throw e;
        // The in-flight item was already released back to Ready; everything behind it is untouched.
        log(`\n✗ run aborted — ${fatal}`);
        log("  (the queue is intact: the claimed item was released, nothing else was touched)");
        deps.runLog.append("run-aborted", { reason: fatal });
        return 1;
      }
      return 0;
    }
  }
};

// `import.meta.main` is bun-only, and bun's bundler lowers it to a CJS `__require` reference that is
// undefined in an ESM bundle under node. This check is the portable equivalent: true when this module IS
// the process entry point, under both runtimes.
// argv[1] must be REALPATH'd first: npm installs the bin as a symlink in node_modules/.bin, so the raw
// path is the link while import.meta.url is the target. Comparing them unresolved silently skips main()
// and exits 0 — a CLI that prints nothing and reports success.
const isEntryPoint = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
};

if (isEntryPoint()) {
  try {
    process.exit(await main(process.argv));
  } catch (e) {
    if (e instanceof RunFatalError) console.error(`✗ ${e.message}${e.hint ? `\n  ${e.hint}` : ""}`);
    else console.error(e instanceof ConfigError ? e.message : `✗ ${String(e)}`);
    process.exit(1);
  }
}
