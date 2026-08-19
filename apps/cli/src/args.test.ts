import { describe, expect, test } from "bun:test";

import { COMMANDS, isReadOnlyInvocation, parseArgs } from "./args.ts";

const argv = (...a: string[]) => ["bun", "hamsterwheel", ...a];

describe("parseArgs", () => {
  test("every command parses", () => {
    for (const c of COMMANDS) expect(parseArgs(argv(c)).command).toBe(c);
  });

  test("no command at all is not an error, just help", () => {
    const a = parseArgs(argv());
    expect(a.command).toBeNull();
    expect(a.unknown).toEqual([]);
  });

  test("flags are independent and default to the safe value", () => {
    const a = parseArgs(argv("run"));
    expect(a).toMatchObject({
      execute: false,
      sandbox: false,
      bypass: false,
      delete: false,
      dryRun: false,
    });
  });

  test("a full run invocation", () => {
    const a = parseArgs(argv("run", "--execute", "--sandbox", "--issue", "412", "--pr-only"));
    expect(a).toMatchObject({
      command: "run",
      execute: true,
      sandbox: true,
      prOnly: true,
      issue: 412,
    });
  });

  test("--issue rejects a non-integer instead of letting NaN reach the CI wait", () => {
    expect(parseArgs(argv("once", "--issue", "abc")).issue).toBeUndefined();
    expect(parseArgs(argv("once", "--issue", "abc")).unknown.join()).toContain("--issue expects");
    expect(parseArgs(argv("once", "--issue", "-3")).issue).toBeUndefined();
    expect(parseArgs(argv("once", "--issue", "3.5")).issue).toBeUndefined();
  });

  test("unknown flags and stray words are collected, not silently ignored", () => {
    expect(parseArgs(argv("plan", "--frobnicate")).unknown).toEqual(["--frobnicate"]);
    expect(parseArgs(argv("frobnicate")).unknown).toEqual(["frobnicate"]);
    // A second command-shaped word is a mistake worth reporting, not a second command.
    expect(parseArgs(argv("plan", "run")).command).toBe("plan");
    expect(parseArgs(argv("plan", "run")).unknown).toEqual(["run"]);
  });

  test("--config takes a path", () => {
    expect(parseArgs(argv("plan", "--config", "/tmp/x.toml")).configPath).toBe("/tmp/x.toml");
  });
});

describe("isReadOnlyInvocation", () => {
  /**
   * The regression: `status` shipped absent from this set, so a monitoring command wrote a run log
   * into the very directory it exists to report on — and left an empty newest run for anything
   * picking "the current run" by mtime.
   */
  test("status only ever reads", () => {
    expect(isReadOnlyInvocation("status", false)).toBe(true);
    expect(isReadOnlyInvocation("status", true)).toBe(true);
  });

  test("plan and reconcile only ever read", () => {
    expect(isReadOnlyInvocation("plan", false)).toBe(true);
    expect(isReadOnlyInvocation("reconcile", false)).toBe(true);
  });

  test("release reads without --execute and writes with it", () => {
    expect(isReadOnlyInvocation("release", false)).toBe(true);
    expect(isReadOnlyInvocation("release", true)).toBe(false);
  });

  test("once and run always write, with or without --execute", () => {
    for (const c of ["once", "run"] as const) {
      expect(isReadOnlyInvocation(c, false)).toBe(false);
      expect(isReadOnlyInvocation(c, true)).toBe(false);
    }
  });
});
