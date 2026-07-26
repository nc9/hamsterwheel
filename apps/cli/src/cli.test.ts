import { describe, expect, it, spyOn } from "bun:test";

import { COMMANDS } from "./args.ts";
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
    const log = spyOn(console, "log").mockImplementation(() => {});
    expect(await main(argv("run"))).toBe(1);
    expect(log.mock.calls[0]?.[0]).toContain("--execute");
    log.mockRestore();
  });
});
