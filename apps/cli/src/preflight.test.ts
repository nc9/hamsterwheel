// The queue-draining incident in one file: an environmental precondition must stop the RUN, never blame
// an ISSUE. These two modules are what stand between a missing token and a burned Ready queue.
import { parseConfig } from "@hamsterwheel/config";
import { describe, expect, test } from "bun:test";

import { RunFatalError, isRunFatal, runFatalReason } from "./errors.ts";
import { preflight, preflightProblems } from "./preflight.ts";

const cfg = parseConfig(
  Bun.TOML.parse(`
repo = "acme/backend"
migration_path_regex = "(^|/)drizzle/"
[project]
number = 1
[runners.implement]
runner = "claude"
[runners.review]
runner = "codex"
`),
  { home: "/home/ci" },
);

const allPresent = (b: string) => `/usr/local/bin/${b}`;
const env = (over: Record<string, string | undefined> = {}) => ({
  HOME: "/home/ci",
  SANDBOX_GITHUB_TOKEN: "ghs_x",
  SANDBOX_ANTHROPIC_API_KEY: "sk-ant-x",
  ...over,
});

describe("preflight", () => {
  test("a healthy environment reports nothing", () => {
    expect(preflightProblems({ cfg, sandbox: true, env: env(), which: allPresent })).toEqual([]);
    expect(() => preflight({ cfg, sandbox: true, env: env(), which: allPresent })).not.toThrow();
  });

  test("EVERY configured runner must exist, not just the implement one", () => {
    const missingCodex = (b: string) => (b === "codex" ? null : allPresent(b));
    const problems = preflightProblems({ cfg, sandbox: false, env: env(), which: missingCodex });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.detail).toContain("`codex` is not on PATH");
  });

  test("a runner a LABEL could select is checked too", () => {
    const noOpencode = (b: string) => (b === "opencode" ? null : allPresent(b));
    const problems = preflightProblems({
      cfg,
      sandbox: false,
      runners: ["claude", "codex", "opencode"],
      env: env(),
      which: noOpencode,
    });
    expect(problems.map((p) => p.detail).join()).toContain("opencode");
  });

  test("THE incident: --sandbox with no token is caught BEFORE anything is claimed", () => {
    const problems = preflightProblems({
      cfg,
      sandbox: true,
      env: env({ SANDBOX_GITHUB_TOKEN: undefined }),
      which: allPresent,
    });
    expect(problems.map((p) => p.check)).toContain("sandbox-credentials");
    expect(() =>
      preflight({
        cfg,
        sandbox: true,
        env: env({ SANDBOX_GITHUB_TOKEN: undefined }),
        which: allPresent,
      }),
    ).toThrow(RunFatalError);
  });

  test("the same missing token is NOT a problem without --sandbox", () => {
    expect(
      preflightProblems({
        cfg,
        sandbox: false,
        env: env({ SANDBOX_GITHUB_TOKEN: undefined }),
        which: allPresent,
      }),
    ).toEqual([]);
  });

  test("missing docker only matters under --sandbox", () => {
    const noDocker = (b: string) => (b === "docker" ? null : allPresent(b));
    expect(preflightProblems({ cfg, sandbox: false, env: env(), which: noDocker })).toEqual([]);
    expect(
      preflightProblems({ cfg, sandbox: true, env: env(), which: noDocker }).map((p) => p.check),
    ).toContain("docker");
  });

  test("every problem is listed in one throw, with a fix hint each", () => {
    try {
      preflight({ cfg, sandbox: true, env: { HOME: undefined }, which: () => null });
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("refusing to start");
      expect(msg).toContain("claude");
      expect(msg).toContain("docker");
      expect(msg).toContain("HOME");
      expect(msg).toContain("SANDBOX_GITHUB_TOKEN");
      expect((e as RunFatalError).hint).toContain("nothing was claimed");
    }
  });
});

describe("runFatalReason", () => {
  const fatal = [
    new RunFatalError("preflight failed"),
    new Error(
      "--sandbox: SANDBOX_GITHUB_TOKEN is required (a short-lived, repo-scoped GitHub token minted per run).",
    ),
    new Error("--sandbox: /x/.git/config carries credential-bearing config (credential-helper)"),
    new Error("spawn claude ENOENT"),
    new Error("gh auth status failed (1): You are not logged into any GitHub hosts"),
    new Error('board field "Owner" not found on project #7'),
    new Error('status option "Blocked" not on the board (have: Ready)'),
    new Error('install_cmd "bun install" failed in /tmp/wt: lockfile mismatch'),
    new Error("gh api failed (1): HTTP 401: Bad credentials"),
  ];
  for (const e of fatal)
    test(`run-fatal: ${e.message.slice(0, 48)}`, () => expect(isRunFatal(e)).toBe(true));

  const issueFatal = [
    new Error("implement session returned no PR url and left changes (or exited non-zero)"),
    new Error("implement session exceeded the 60m timeout — killed"),
    new Error("no JSON verdict in rubric output"),
    new Error("could not parse a PR number from the implement output: not-a-url"),
    new Error("rubric session timed out"),
  ];
  for (const e of issueFatal)
    test(`issue-fatal: ${e.message.slice(0, 48)}`, () => {
      expect(isRunFatal(e)).toBe(false);
      expect(runFatalReason(e)).toBeNull();
    });

  test("classifies non-Error throws without exploding", () => {
    expect(isRunFatal("SANDBOX_GITHUB_TOKEN missing")).toBe(true);
    expect(isRunFatal(undefined)).toBe(false);
  });
});
