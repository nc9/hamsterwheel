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
[project]
number = 3
[[human]]
name = "prod-migration"
paths = "(^|/)drizzle/"
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
    // Deliberately the looser default: `required` would wedge every repo without a review bot.
    expect(c.review.mode).toBe("optional");
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
    expect(problems({ human: [{ name: "m", paths: "x" }], project: { number: 1 } })).toContain(
      "repo is required (string)",
    );
    expect(problems({ ...minimal(), repo: "backend" }).join()).toContain('"owner/name" slug');
  });

  test("a path-based [[human]] rule is required — without one a schema change could auto-merge", () => {
    const raw = minimal();
    delete (raw as Record<string, unknown>).human;
    expect(problems(raw).join()).toContain("at least one [[human]] rule with `paths` is required");
    // Label-only rules do NOT satisfy the requirement — labels are optional human input.
    expect(problems(withOver({ human: [{ name: "sec", labels: ["security"] }] })).join()).toContain(
      "at least one [[human]] rule with `paths` is required",
    );
  });

  test("the removed migration_path_regex key errors with the replacement syntax", () => {
    const p = problems(withOver({ migration_path_regex: "(^|/)drizzle/" })).join();
    expect(p).toContain("replaced by [[human]] rules");
    expect(p).toContain('paths = "(^|/)(migrations|drizzle)/"');
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
      human: [{ name: "m", paths: "([unclosed" }],
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

  test("review.mode accepts each valid value, case-insensitively", () => {
    for (const mode of ["required", "optional", "off"] as const)
      expect(parseConfig(withOver({ review: { mode } }), { home: "/h" }).review.mode).toBe(mode);
    expect(parseConfig(withOver({ review: { mode: "OFF" } }), { home: "/h" }).review.mode).toBe(
      "off",
    );
  });

  test("an unknown review.mode is rejected, naming the valid values", () => {
    const p = problems(withOver({ review: { mode: "sometimes" } })).join();
    expect(p).toContain("review.mode");
    expect(p).toContain("required | optional | off");
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

  test("rule path regexes compile case-insensitively", () => {
    const c = parseConfig(withOver({ human: [{ name: "m", paths: "(^|/)DRIZZLE/" }] }), {
      home: "/h",
    });
    expect(c.humanRules[0]!.pathsRe!.test("apps/api/drizzle/0001.sql")).toBe(true);
    expect(c.humanRules[0]!.pathsRe!.test("apps/api/src/index.ts")).toBe(false);
  });

  test("[[human]] rules: labels + paths parse, and malformed rules name the exact problem", () => {
    const c = parseConfig(
      withOver({
        human: [
          { name: "prod-migration", paths: "(^|/)drizzle/" },
          { name: "sensitive-domain", labels: ["security", " auth "] },
        ],
      }),
      { home: "/h" },
    );
    expect(c.humanRules.map((h) => h.name)).toEqual(["prod-migration", "sensitive-domain"]);
    expect(c.humanRules[1]!.labels).toEqual(["security", "auth"]);

    expect(problems(withOver({ human: [{ name: "x" }] })).join()).toContain(
      "needs paths and/or labels",
    );
    expect(problems(withOver({ human: [{ paths: "x" }] })).join()).toContain("human[0].name");
    expect(
      problems(
        withOver({
          human: [
            { name: "dup", paths: "x" },
            { name: "DUP", labels: ["a"] },
          ],
        }),
      ).join(),
    ).toContain('"DUP" is duplicated');
    expect(
      problems(withOver({ human: [{ name: "m", paths: "x", label: ["a"] }] })).join(),
    ).toContain("human[0].label is not a known key");
    expect(problems(withOver({ human: [{ name: "m", paths: "x", labels: [] }] })).join()).toContain(
      "human[0].labels must be a non-empty array",
    );
  });

  test("numeric limits enforce a floor rather than silently accepting nonsense", () => {
    expect(problems(withOver({ ci_timeout_ms: 10 })).join()).toContain("ci_timeout_ms");
    expect(problems(withOver({ max_diff_bytes: 0 })).join()).toContain("max_diff_bytes");
    expect(problems(withOver({ worktree_lanes: 0 })).join()).toContain("worktree_lanes");
  });

  test("worktree_lanes defaults to 1", () => {
    expect(parseConfig(minimal(), { home: "/h" }).worktreeLanes).toBe(1);
    expect(parseConfig(withOver({ worktree_lanes: 5 }), { home: "/h" }).worktreeLanes).toBe(5);
  });

  test("[scripts]: setup parses, absence means no setup step", () => {
    expect(parseConfig(minimal(), { home: "/h" }).scripts).toEqual({});
    expect(
      parseConfig(withOver({ scripts: { setup: " ./scripts/setup.sh " } }), { home: "/h" }).scripts
        .setup,
    ).toBe("./scripts/setup.sh");
  });

  test("[scripts]: unknown keys are errors, not silent no-ops (a typo must not skip setup)", () => {
    expect(problems(withOver({ scripts: { setup: "x", steup: "y" } })).join()).toContain(
      "scripts.steup is not supported",
    );
    expect(problems(withOver({ scripts: { run: "bun dev" } })).join()).toContain(
      "scripts.run is not supported",
    );
    expect(problems(withOver({ scripts: "bun install" })).join()).toContain(
      "scripts must be a table",
    );
    expect(problems(withOver({ scripts: { setup: "" } })).join()).toContain(
      "scripts.setup must be a non-empty string",
    );
  });

  test("the removed install_cmd key is a hard error pointing at [scripts]", () => {
    const p = problems(withOver({ install_cmd: "bun install" })).join();
    expect(p).toContain("install_cmd was replaced by the [scripts] table");
    expect(p).toContain('setup = "bun install"');
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
