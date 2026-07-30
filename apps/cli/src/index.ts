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
import { type ParsedArgs, parseArgs, validateArgs } from "./args.ts";
import { loadBoardCtx } from "./board.ts";
import {
  type CommandDeps,
  plan,
  reconcile,
  renderPlan,
  renderReconcile,
  renderTriage,
  runTriagePasses,
  triage,
  workQueue,
} from "./commands.ts";
import { doctor } from "./doctor.ts";
import { RunFatalError, runFatalReason } from "./errors.ts";
import { Gh } from "./gh.ts";
import { commandHelp, globalHelp } from "./help.ts";
import { init } from "./init.ts";
import { preflight } from "./preflight.ts";
import { fetchRateLimits, quotaVerdict } from "./quota.ts";
import { runPrune } from "./prune.ts";
import { release, renderRelease } from "./release.ts";
import { type RunLog, createRunLog, makeRunId } from "./runlog.ts";

export const HELP = globalHelp(pkg.version);

/** Resolve the config for a board-backed command, or explain why we can't. */
const resolveConfig = async (args: ParsedArgs): Promise<Config> => {
  const path = args.configPath ?? (await findConfig(process.cwd()));
  if (!path)
    throw new ConfigError([
      `no ${CONFIG_FILENAME} found from ${process.cwd()} upward — run \`hamster init\``,
    ]);
  return loadConfig(path);
};

/** JSON-mode error payload: same taxonomy the human output uses, machine-readable. */
const describeError = (e: unknown): Record<string, unknown> => {
  if (e instanceof RunFatalError)
    return { kind: "run-fatal", message: e.message, ...(e.hint ? { hint: e.hint } : {}) };
  if (e instanceof ConfigError) return { kind: "config", problems: e.problems };
  const fatal = runFatalReason(e);
  if (fatal) return { kind: "run-fatal", message: fatal };
  return { kind: "error", message: e instanceof Error ? e.message : String(e) };
};

export const main = async (argv: string[]): Promise<number> => {
  const args = parseArgs(argv);
  // In --json mode stdout carries exactly one JSON object; every human-facing line goes to stderr so
  // `hamster … --json | jq` never chokes on progress text.
  const log = (...m: unknown[]) => (args.json ? console.error(...m) : console.log(...m));
  const emit = (obj: Record<string, unknown>) =>
    console.log(JSON.stringify({ ok: true, command: args.command, ...obj }, null, 2));
  const fail = (code: number, message: string, extra?: Record<string, unknown>): number => {
    if (args.json)
      console.log(
        JSON.stringify(
          { ok: false, command: args.command, error: { kind: "usage", message }, ...extra },
          null,
          2,
        ),
      );
    console.error(message);
    return code;
  };

  const problems = [
    ...args.unknown.map((u) => `unknown or malformed argument: ${u}`),
    ...validateArgs(args),
  ];
  if (problems.length)
    return fail(
      1,
      `${problems.join("\n")}\nrun \`hamster ${args.command ? `${args.command} ` : ""}--help\`.`,
    );
  // Even help/version honor the single-JSON-object contract when --json is passed.
  if (args.version) {
    console.log(args.json ? JSON.stringify({ ok: true, version: pkg.version }) : pkg.version);
    return 0;
  }
  if (args.help || args.command === null) {
    const text = args.command ? commandHelp(args.command, pkg.version) : HELP;
    console.log(args.json ? JSON.stringify({ ok: true, command: args.command, help: text }) : text);
    return 0;
  }

  // Checked before anything reads config or touches GitHub: a `run` typed without --execute should cost
  // nothing and change nothing.
  if (args.command === "run" && !args.execute)
    return fail(
      1,
      "⚠ `run` requires --execute to loop — use `once` for a single dry pass, or `plan` to inspect.",
    );
  // A release --execute with nothing to execute must fail before any GitHub call, not mid-cut.
  if (args.command === "release" && args.execute && !args.tag && !args.archiveDone)
    return fail(
      1,
      "⚠ `release --execute` needs --tag <v> (cut a release) or --archive-done (backfill archive).",
    );
  // The backfill arm has no tag and no notes — combining it with release-arm flags would silently
  // ignore them, and a silently-ignored flag is the exact failure mode validateArgs exists to prevent.
  if (args.command === "release" && args.archiveDone && (args.tag || args.changelog))
    return fail(1, "⚠ --archive-done is the backfill arm: it takes no --tag and no --changelog.");
  // --json cannot answer a y/N prompt; require the intent up front instead of dying mid-provision.
  if (args.command === "init" && args.json && !args.yes && !args.dryRun)
    return fail(1, "init --json is non-interactive — pass --yes to apply or --dry-run to preview.");

  try {
    const gh = new Gh();
    if (args.command === "init") {
      const { code, report } = await init({
        cwd: process.cwd(),
        yes: args.yes,
        dryRun: args.dryRun,
        projectTitle: args.projectTitle,
        log,
        gh,
      });
      if (args.json)
        console.log(JSON.stringify({ ok: code === 0, command: "init", ...report }, null, 2));
      return code;
    }
    if (args.command === "doctor") {
      const { code, checks } = await doctor({ cwd: process.cwd(), log, gh });
      if (args.json)
        console.log(
          JSON.stringify(
            {
              ok: code === 0,
              command: "doctor",
              checks,
              failed: checks.filter((c) => c.status === "fail").length,
              warned: checks.filter((c) => c.status === "warn").length,
            },
            null,
            2,
          ),
        );
      return code;
    }

    const cfg = await resolveConfig(args);

    // prune needs no board — it runs standalone, ahead of any project lookup.
    if (args.command === "prune") {
      log(`🐹 prune${args.delete ? " (--delete)" : " (dry run)"}`);
      const report = await runPrune(gh, cfg, { delete: args.delete, log });
      const failed = report.deleted.some((d) => !d.ok);
      if (args.json) emit({ ...report, ok: !failed } as Record<string, unknown>);
      return failed ? 1 : 0;
    }

    const ctx = await loadBoardCtx(gh, cfg);
    const readOnly =
      args.command === "plan" ||
      args.command === "reconcile" ||
      (args.command === "release" && !args.execute);
    // Tee the run log so --json can replay the exact structured events the .jsonl file records.
    const events: Record<string, unknown>[] = [];
    const base = createRunLog({
      dir: `${process.env.HOME}/.hamsterwheel/runs`,
      runId: makeRunId(0),
    });
    const runLog: RunLog = {
      ...base,
      append: (event, data = {}) => {
        base.append(event, data);
        // Same shape as the .jsonl lines, so "events mirror the run log" is literally true.
        events.push({ ts: new Date().toISOString(), run: base.runId, event, ...data });
      },
    };
    const deps: CommandDeps = {
      gh,
      cfg,
      ctx,
      log,
      runLog,
      prOnly: args.prOnly,
      sandbox: args.sandbox,
      bypassPermissions: args.bypass,
    };
    log(
      `🐹 hamsterwheel — ${cfg.repo} · project #${ctx.projectNumber} · ${args.command}${args.execute ? " (--execute)" : ""}`,
    );
    if (!readOnly) runLog.append("start", { command: args.command, execute: args.execute });

    switch (args.command) {
      case "plan": {
        const report = await plan(deps);
        if (args.json) emit({ ...report });
        else renderPlan(report, log);
        return 0;
      }
      case "reconcile": {
        const report = await reconcile(deps);
        if (args.json) emit({ ...report });
        else renderReconcile(report, cfg, log);
        return 0;
      }
      case "release": {
        const report = await release(deps, {
          execute: args.execute,
          tag: args.tag,
          changelog: args.changelog,
          archiveDone: args.archiveDone,
          date: new Date().toISOString().slice(0, 10),
        });
        renderRelease(report, log);
        const failed =
          report.archive.archived.some((a) => !a.ok) || report.changelog?.action === "failed";
        if (args.json) emit({ ...report, ok: !failed } as Record<string, unknown>);
        return failed ? 1 : 0;
      }
      case "triage": {
        const report = await triage(deps, args.sync);
        if (!args.json) renderTriage(report, ctx.projectNumber, cfg.repo, log);
        // The auto-block passes MUTATE the board, so they stay behind --execute like every other write.
        let autoBlocked: Awaited<ReturnType<typeof runTriagePasses>> = [];
        if (args.execute) autoBlocked = await runTriagePasses(deps);
        else log("\n(read-only: pass --execute to apply the auto-block passes)");
        if (args.json) emit({ ...report, autoBlocked });
        return 0;
      }
      default: {
        if (args.bypass && !args.sandbox)
          log(
            "⚠ --bypass without --sandbox: the session gets unrestricted tools with no isolation boundary.",
          );
        // Refuse to START on a precondition that would fail identically for every item. Discovering it
        // per-issue is how a whole curated Ready queue got burned into Blocked in under a minute.
        // The quota read is free, so it costs nothing to fold into the same refusal.
        if (args.execute) {
          const quota = quotaVerdict(await fetchRateLimits(gh), {
            nowSeconds: Math.floor(Date.now() / 1000),
          });
          if (quota.level === "warn") log(`! quota: ${quota.detail}`);
          preflight({ cfg, sandbox: args.sandbox, quota });
        }
        if (args.execute) await runTriagePasses(deps);
        const summarize = () => {
          const count = (e: string) => events.filter((x) => x["event"] === e).length;
          return {
            claimed: count("claim"),
            prsOpened: count("pr-open"),
            merged: count("merged"),
            done: count("done"),
            blocked: count("blocked"),
            failed: count("failed"),
          };
        };
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
          runLog.append("run-aborted", { reason: fatal });
          if (args.json)
            console.log(
              JSON.stringify(
                {
                  ok: false,
                  command: args.command,
                  execute: args.execute,
                  error: { kind: "run-fatal", message: fatal },
                  events,
                  summary: summarize(),
                },
                null,
                2,
              ),
            );
          return 1;
        }
        if (args.json) emit({ execute: args.execute, events, summary: summarize() });
        return 0;
      }
    }
  } catch (e) {
    if (!args.json) throw e;
    console.log(
      JSON.stringify({ ok: false, command: args.command, error: describeError(e) }, null, 2),
    );
    return 1;
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
