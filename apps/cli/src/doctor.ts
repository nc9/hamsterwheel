import { CONFIG_FILENAME, ConfigError, findConfig, loadConfig } from "@hamsterwheel/config";
import { detectRunners, git, systemRunnerLookup, whichBin } from "@hamsterwheel/runners";

import { Gh } from "./gh.ts";

/**
 * Prerequisite verification, shared by `doctor` and the first half of `init`. Every check answers one
 * question and reports `ok | warn | fail` — `warn` means "a mode is unavailable", `fail` means "the loop
 * cannot run at all".
 */
export type CheckStatus = "ok" | "warn" | "fail";
export type Check = { name: string; status: CheckStatus; detail: string };

const has = (bin: string): boolean => whichBin(bin) !== null;

/** `gh auth status` prints scopes as `- Token scopes: 'gist', 'read:org', 'repo'`. */
export const parseTokenScopes = (authStatus: string): string[] => {
  const m = authStatus.match(/Token scopes:\s*(.+)/i);
  return m ? [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!) : [];
};

export const runChecks = async (opts: { cwd: string; gh?: Gh }): Promise<Check[]> => {
  const gh = opts.gh ?? new Gh();
  const checks: Check[] = [];

  if (!has("git")) checks.push({ name: "git", status: "fail", detail: "not on PATH" });
  else {
    const root = (await git(["rev-parse", "--show-toplevel"], opts.cwd)).stdout.trim();
    checks.push(
      root
        ? { name: "git repo", status: "ok", detail: root }
        : {
            name: "git repo",
            status: "fail",
            detail: `${opts.cwd} is not inside a git repository`,
          },
    );
  }

  if (!has("gh")) {
    checks.push({ name: "gh", status: "fail", detail: "not on PATH — install the GitHub CLI" });
  } else {
    const status = await gh.tryText(["auth", "status"]);
    if (status === null) {
      checks.push({
        name: "gh auth",
        status: "fail",
        detail: "not authenticated — run `gh auth login`",
      });
    } else {
      const scopes = parseTokenScopes(status);
      checks.push({
        name: "gh auth",
        status: "ok",
        detail: `authenticated (scopes: ${scopes.join(", ") || "unknown"})`,
      });
      // Projects v2 is GraphQL-only and needs its own scope; without it every board mutation 403s.
      checks.push(
        scopes.length === 0 || scopes.includes("project")
          ? {
              name: "gh project scope",
              status: scopes.length ? "ok" : "warn",
              detail: scopes.length
                ? "project scope present"
                : "could not read scopes — verify manually",
            }
          : {
              name: "gh project scope",
              status: "fail",
              detail: "missing the `project` scope — run `gh auth refresh -s project`",
            },
      );
    }
  }

  checks.push(
    has("docker")
      ? { name: "docker", status: "ok", detail: "available — --sandbox usable" }
      : {
          name: "docker",
          status: "warn",
          detail: "not on PATH — --sandbox (OS isolation) unavailable",
        },
  );

  const runners = await detectRunners(systemRunnerLookup);
  const available = runners.filter((r) => r.available);
  checks.push(
    available.length
      ? {
          name: "agent runners",
          status: "ok",
          detail: available.map((r) => `${r.runner}${r.version ? ` ${r.version}` : ""}`).join(", "),
        }
      : {
          name: "agent runners",
          status: "fail",
          detail: "none of claude/codex/opencode found on PATH",
        },
  );

  const configPath = await findConfig(opts.cwd);
  if (!configPath) {
    checks.push({
      name: "config",
      status: "warn",
      detail: `no ${CONFIG_FILENAME} found — run \`hamsterwheel init\``,
    });
    return checks;
  }
  try {
    const cfg = await loadConfig(configPath);
    checks.push({ name: "config", status: "ok", detail: `${configPath} → ${cfg.repo}` });
    // The board is the control plane; a config that points at a missing board is a fail, not a warn.
    const list = await gh.tryJson<{ projects: { number: number; title: string }[] }>([
      "project",
      "list",
      "--owner",
      cfg.project.owner,
      "--format",
      "json",
      "--limit",
      "100",
    ]);
    const project = list?.projects.find(
      (p) =>
        p.number === cfg.project.number ||
        (cfg.project.title !== undefined && p.title === cfg.project.title),
    );
    checks.push(
      project
        ? { name: "project board", status: "ok", detail: `#${project.number} "${project.title}"` }
        : {
            name: "project board",
            status: "fail",
            detail: `no project ${cfg.project.number ?? cfg.project.title} under ${cfg.project.owner}`,
          },
    );
  } catch (e) {
    checks.push({
      name: "config",
      status: "fail",
      detail: e instanceof ConfigError ? e.problems.join("; ") : String(e).slice(0, 300),
    });
  }
  return checks;
};

const ICON: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

export const printChecks = (checks: Check[], log: (m: string) => void): void => {
  for (const c of checks) log(`  ${ICON[c.status]} ${c.name.padEnd(18)} ${c.detail}`);
};

/** Exit code: 1 if anything is broken, 0 when only warnings remain. */
export const doctor = async (opts: {
  cwd: string;
  log: (m: string) => void;
  gh?: Gh;
}): Promise<number> => {
  const checks = await runChecks(opts);
  opts.log("🐹 hamsterwheel doctor\n");
  printChecks(checks, opts.log);
  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");
  opts.log(
    `\n${failed.length ? `${failed.length} blocking problem(s)` : "ready"}${warned.length ? `, ${warned.length} warning(s)` : ""}.`,
  );
  return failed.length ? 1 : 0;
};
