import { describe, expect, it, spyOn } from "bun:test";

import { main, PLANNED_COMMANDS } from "./index";

function argv(...args: string[]): string[] {
  return ["bun", "hamsterwheel", ...args];
}

describe("hamsterwheel cli", () => {
  it("prints the version and exits 0", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    expect(main(argv("--version"))).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("prints help and exits 0 with no args", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    expect(main(argv())).toBe(0);
    log.mockRestore();
  });

  it("exits 0 for every planned-but-unimplemented command", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    for (const command of PLANNED_COMMANDS) {
      expect(main(argv(command))).toBe(0);
    }
    log.mockRestore();
  });

  it("exits 1 for an unknown command", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    expect(main(argv("frobnicate"))).toBe(1);
    err.mockRestore();
  });
});
