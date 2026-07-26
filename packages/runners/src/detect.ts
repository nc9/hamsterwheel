import { RUNNERS, type RunnerName } from "./runner.ts";

export type RunnerProbe = { path: string | null; version: string | null };
/** Injected so detection is testable without a PATH lookup or a spawn. */
export type RunnerLookup = (runner: RunnerName) => RunnerProbe | Promise<RunnerProbe>;

export type DetectedRunner = {
  runner: RunnerName;
  available: boolean;
  path: string | null;
  version: string | null;
};

/** Which agent CLIs this machine can actually drive. Availability = a resolvable binary path. */
export const detectRunners = async (lookup: RunnerLookup): Promise<DetectedRunner[]> =>
  Promise.all(
    RUNNERS.map(async (runner) => {
      const probe = await lookup(runner);
      return { runner, available: probe.path !== null, path: probe.path, version: probe.version };
    }),
  );

/**
 * Real PATH lookup + `--version`. Impure boundary, kept trivial so the pure `detectRunners` above owns
 * the logic. A binary that exists but whose --version fails still counts as available — an odd version
 * banner is not a reason to refuse to run it.
 */
export const systemRunnerLookup: RunnerLookup = async (runner) => {
  const path = Bun.which(runner);
  if (!path) return { path: null, version: null };
  const proc = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const version = out.trim().split("\n")[0]?.trim();
  return { path, version: version || null };
};
