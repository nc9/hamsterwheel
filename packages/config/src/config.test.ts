// Config validation is pure, so it is tested against parsed TOML documents directly. The one IO test
// round-trips the shipped example file — if that drifts out of sync with the schema, first runs break.
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { ConfigError, parseConfig } from "./index.ts";
import { CONFIG_FILENAME, findConfig, loadConfig } from "./load.ts";

const minimal = (over: Record<string, unknown> = {}) =>
  Bun.TOML.parse(`
repo = "acme/backend"
migration_path_regex = "(^|/)drizzle/"
[project]
number = 3
`) as Record<string, unknown> & typeof over;

const withOver = (over: Record<string, unknown>) => ({ ...minimal(), ...over });

const problems = (raw: unknown): string[] => {
  try {
    parseConfig(raw, { home: "/home/ci" });
    return [];
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
};

describe("parseConfig — defaults", () => {
  test("a minimal document fills every default", () => {
    const c = parseConfig(minimal(), { home: "/home/ci" });
    expect(c.repo).toBe("acme/backend");
    expect(c.owner).toBe("acme");
    expect(c.baseBranch).toBe("main");
    expect(c.branchPrefix).toBe("loop");
    expect(c.project).toMatchObject({ owner: "acme", number: 3 });
    expect(c.board.status.inProgress).toBe("In Progress");
    expect(c.board.blockedReasons.needsCriteria).toBe("needs-criteria");
    expect(c.review.bot).toBe("claude[bot]");
    expect(c.runners.implement.runner).toBe("claude");
    expect(c.sessionTimeoutMs).toBe(3_600_000);
    expect(c.worktreeRoot).toBe("/home/ci/.hamsterwheel/worktrees");
    expect(c.sourceRepos).toEqual(["acme/backend"]);
  });

  test("board names are fully overridable — no squirrelscan vocabulary is hardcoded", () => {
    const c = parseConfig(
      withOver({
        board: {
          status_field: "State",
          owner_field: "Claimed by",
          blocked_reason_field: "Why blocked",
          status: {
            draft: "Icebox",
            ready: "Todo",
            in_progress: "Doing",
            in_review: "Review",
            blocked: "Stuck",
            done: "Shipped",
          },
          blocked_reasons: { needs_criteria: "no-criteria" },
        },
      }),
      { home: "/home/ci" },
    );
    expect(c.board.statusField).toBe("State");
    expect(c.board.ownerField).toBe("Claimed by");
    expect(c.board.status.ready).toBe("Todo");
    expect(c.board.status.done).toBe("Shipped");
    expect(c.board.blockedReasons.needsCriteria).toBe("no-criteria");
    expect(c.board.blockedReasons.ciRed).toBe("ci-red"); // unset keys keep their default
  });
});

describe("parseConfig — required fields", () => {
  test("repo is required and must be a slug", () => {
    expect(problems({ migration_path_regex: "x", project: { number: 1 } })).toContain(
      "repo is required (string)",
    );
    expect(problems({ ...minimal(), repo: "backend" }).join()).toContain('"owner/name" slug');
  });

  test("migration_path_regex is required — a missing one could auto-merge a schema change", () => {
    const raw = minimal();
    delete (raw as Record<string, unknown>).migration_path_regex;
    expect(problems(raw).join()).toContain("migration_path_regex is required");
  });

  test("a project reference is required", () => {
    const raw = minimal();
    delete (raw as Record<string, unknown>).project;
    expect(problems(raw).join()).toContain("project.number or project.title is required");
  });

  test("project.title alone is enough", () => {
    expect(
      parseConfig(withOver({ project: { title: "Loop" } }), { home: "/h" }).project.title,
    ).toBe("Loop");
  });
});

describe("parseConfig — value validation", () => {
  test("every problem is reported at once, not one per run", () => {
    const p = problems({
      repo: "not-a-slug",
      migration_path_regex: "([unclosed",
      branch_prefix: "-bad prefix",
      session_timeout_ms: 5,
      allowed_tools: ["ok", 42],
      project: {},
    });
    expect(p.length).toBeGreaterThanOrEqual(5);
    expect(p.join()).toContain("owner/name");
    expect(p.join()).toContain("not a valid regular expression");
    expect(p.join()).toContain("branch_prefix");
    expect(p.join()).toContain("session_timeout_ms");
    expect(p.join()).toContain("allowed_tools");
  });

  test("an unknown runner is rejected by name", () => {
    expect(problems(withOver({ runners: { implement: { runner: "gemini" } } })).join()).toContain(
      "runners.implement.runner must be one of claude | codex | opencode",
    );
  });

  test("a config effort must match its runner's vocabulary (unlike a label, which falls back silently)", () => {
    expect(
      problems(withOver({ runners: { review: { runner: "codex", effort: "max" } } })).join(),
    ).toContain('runners.review.effort "max" is not valid for runner codex');
    expect(
      problems(withOver({ runners: { review: { runner: "claude", effort: "max" } } })),
    ).toEqual([]);
  });

  test("regexes compile case-insensitively", () => {
    const c = parseConfig(withOver({ migration_path_regex: "(^|/)DRIZZLE/" }), { home: "/h" });
    expect(c.migrationPathRe.test("apps/api/drizzle/0001.sql")).toBe(true);
    expect(c.migrationPathRe.test("apps/api/src/index.ts")).toBe(false);
  });

  test("numeric limits enforce a floor rather than silently accepting nonsense", () => {
    expect(problems(withOver({ ci_timeout_ms: 10 })).join()).toContain("ci_timeout_ms");
    expect(problems(withOver({ max_diff_bytes: 0 })).join()).toContain("max_diff_bytes");
  });

  test("a non-table document is rejected outright", () => {
    expect(problems("repo = 1")).toEqual([
      "config must be a TOML table (got a non-object document)",
    ]);
  });

  test("source_repos entries are slug-checked", () => {
    expect(problems(withOver({ source_repos: ["acme/backend", "oops"] })).join()).toContain(
      'source_repos entry "oops"',
    );
  });
});

describe("loadConfig / findConfig", () => {
  test("the shipped example file parses", async () => {
    const c = await loadConfig(`${import.meta.dir}/../../../hamsterwheel.example.toml`);
    expect(c.repo).toBe("acme/backend");
    expect(c.runners.implement.strongModel).toBe("opus");
    expect(c.review.blockingSeverityRe.test("- something bad (high)")).toBe(true);
    expect(c.review.blockingSeverityRe.test("- a nit (low)")).toBe(false);
    expect(c.allowedTools).toContain("Bash(git:*)");
  });

  test("a missing file names the fix", async () => {
    await expect(loadConfig("/nonexistent/hamsterwheel.toml")).rejects.toThrow("hamsterwheel init");
  });

  test("invalid TOML reports the file, not a module stack", async () => {
    const path = `${import.meta.dir}/../.tmp-bad.toml`;
    await Bun.write(path, "repo = [unclosed\n");
    await expect(loadConfig(path)).rejects.toThrow("not valid TOML");
    await Bun.file(path).delete();
  });

  test("findConfig walks up from a nested dir, and returns null when there is nothing to find", async () => {
    const root = `${tmpdir()}/hw-cfg-${crypto.randomUUID()}`;
    await Bun.write(`${root}/${CONFIG_FILENAME}`, 'repo = "acme/backend"\n');
    await Bun.write(`${root}/a/b/keep.txt`, "");
    expect(await findConfig(`${root}/a/b`)).toBe(`${root}/${CONFIG_FILENAME}`);
    rmSync(root, { recursive: true, force: true });
    expect(await findConfig(`${tmpdir()}/hw-cfg-none-${crypto.randomUUID()}`)).toBeNull();
  });
});
