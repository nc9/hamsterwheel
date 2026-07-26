import type { Config } from "@hamsterwheel/config";
import { resolveSandboxEnv } from "@hamsterwheel/sandbox";
import { RUNNERS, type RunnerName } from "@hamsterwheel/runners";

import { RunFatalError } from "./errors.ts";

/**
 * Everything that would fail identically for EVERY issue, checked once before the first claim.
 *
 * This is the counterpart to the run-fatal taxonomy (errors.ts): the taxonomy stops a mid-run
 * environmental failure from draining the queue, and this stops the run from starting at all when the
 * failure is already knowable. `run`/`once --execute` refuse to start rather than burn a curated queue.
 *
 * Pure-ish: the environment and the binary lookup are injected so the whole matrix is unit-testable.
 */
export type PreflightInput = {
  cfg: Config;
  sandbox: boolean;
  /** Runners the run could actually spawn — config defaults, plus anything a label may select. */
  runners?: RunnerName[];
  env?: Record<string, string | undefined>;
  which?: (bin: string) => string | null;
};

export type PreflightProblem = { check: string; detail: string; hint: string };

export const preflightProblems = (input: PreflightInput): PreflightProblem[] => {
  const env = input.env ?? process.env;
  const which = input.which ?? ((b: string) => Bun.which(b));
  const problems: PreflightProblem[] = [];

  // Any runner a label could select must exist too: discovering a missing binary on issue #7 of 20
  // would block issue #7 for an environment reason.
  const runners = input.runners ?? [
    input.cfg.runners.implement.runner,
    input.cfg.runners.review.runner,
  ];
  for (const r of new Set(runners))
    if (!which(r))
      problems.push({
        check: "runner",
        detail: `\`${r}\` is not on PATH (configured for ${r === input.cfg.runners.review.runner ? "review" : "implement"} sessions)`,
        hint: RUNNERS.includes(r)
          ? `install ${r}, or point runners.* at an installed runner`
          : "unknown runner",
      });

  if (!env.HOME)
    problems.push({
      check: "home",
      detail: "HOME is not set",
      hint: "the worktree root cannot be resolved",
    });

  if (input.sandbox) {
    if (!which("docker"))
      problems.push({
        check: "docker",
        detail: "`docker` is not on PATH",
        hint: "install docker, or drop --sandbox",
      });
    // The exact failure that drained a queue: fail-closed sandbox credentials, evaluated per issue.
    try {
      resolveSandboxEnv(env);
    } catch (e) {
      problems.push({
        check: "sandbox-credentials",
        detail:
          String(e instanceof Error ? e.message : e).split(".")[0] ?? "missing sandbox credentials",
        hint: "export the per-run token(s) before launching, or drop --sandbox",
      });
    }
  }

  return problems;
};

/** Throw a single RunFatalError listing every precondition problem, or return cleanly. */
export const preflight = (input: PreflightInput): void => {
  const problems = preflightProblems(input);
  if (!problems.length) return;
  throw new RunFatalError(
    `preflight failed — refusing to start (${problems.length} precondition${problems.length === 1 ? "" : "s"}):\n` +
      problems.map((p) => `  ✗ ${p.check}: ${p.detail}\n      → ${p.hint}`).join("\n"),
    "these would fail identically for every issue; nothing was claimed",
  );
};
