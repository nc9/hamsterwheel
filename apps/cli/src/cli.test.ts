import { describe, expect, it, spyOn } from "bun:test";

import { COMMANDS, FLAG_SPECS, parseArgs, validateArgs } from "./args.ts";
import { commandHelp } from "./help.ts";
import { HELP, main } from "./index.ts";

const argv = (...args: string[]): string[] => ["bun", "hamsterwheel", ...args];

describe("hamsterwheel cli", () => {
  it("prints the version and exits 0", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    expect(await main(argv("--version"))).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("prints help with no args", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    expect(await main(argv())).toBe(0);
    log.mockRestore();
  });

  it("exits 1 for an unknown command, without touching the network", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    expect(await main(argv("frobnicate"))).toBe(1);
    expect(err.mock.calls[0]?.[0]).toContain("frobnicate");
    err.mockRestore();
  });

  it("documents every command it accepts", () => {
    for (const c of COMMANDS) expect(HELP).toContain(`  ${c}`);
  });

  it("`run` without --execute exits 1 before reading config or touching GitHub", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    expect(await main(argv("run"))).toBe(1);
    expect(err.mock.calls[0]?.[0]).toContain("--execute");
    err.mockRestore();
  });

  it("prints per-command help for `hamster <cmd> --help`", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    expect(await main(argv("prune", "--help"))).toBe(0);
    const out = String(log.mock.calls[0]?.[0]);
    expect(out).toContain("hamster prune");
    expect(out).toContain("--delete");
    expect(out).toContain("Exit codes");
    expect(out).toContain("JSON output");
    log.mockRestore();
  });

  it("every command's help documents every flag it accepts, and --json", () => {
    for (const c of COMMANDS) {
      const help = commandHelp(c, "0.0.0");
      for (const spec of FLAG_SPECS.filter((s) => s.commands === "all" || s.commands.includes(c)))
        expect(help).toContain(spec.flag);
      expect(help).toContain("--json");
    }
  });

  it("rejects a flag on a command it does not apply to", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    expect(await main(argv("plan", "--delete"))).toBe(1);
    expect(err.mock.calls[0]?.[0]).toContain("--delete");
    expect(err.mock.calls[0]?.[0]).toContain("prune");
    err.mockRestore();
  });

  it("validateArgs pinpoints the offending flag and its valid commands", () => {
    const problems = validateArgs(parseArgs(argv("doctor", "--sync")));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("--sync");
    expect(problems[0]).toContain("triage");
    expect(validateArgs(parseArgs(argv("triage", "--sync")))).toHaveLength(0);
    // global flags apply everywhere
    expect(validateArgs(parseArgs(argv("doctor", "--json")))).toHaveLength(0);
  });

  it("usage errors in --json mode emit a machine-readable object on stdout", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    expect(await main(argv("plan", "--delete", "--json"))).toBe(1);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe("usage");
    log.mockRestore();
    err.mockRestore();
  });

  it("init --json without --yes/--dry-run refuses instead of hanging on a prompt", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    expect(await main(argv("init", "--json"))).toBe(1);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toContain("--yes");
    log.mockRestore();
    err.mockRestore();
  });

  it("--issue rejects non-numeric values at parse time", () => {
    const parsed = parseArgs(argv("once", "--issue", "abc"));
    expect(parsed.issue).toBeUndefined();
    expect(parsed.unknown[0]).toContain("--issue");
  });
});
