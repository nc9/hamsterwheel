import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { createRunLog, makeRunId, nullRunLog } from "./runlog.ts";

const fixedClock = (iso: string) => () => new Date(iso);

describe("createRunLog", () => {
  test("writes one JSON object per line, timestamped from the INJECTED clock", async () => {
    const dir = `${tmpdir()}/hw-runlog-${crypto.randomUUID()}`;
    const log = createRunLog({
      dir,
      runId: "loop-abc-7",
      now: fixedClock("2026-07-25T10:11:12.000Z"),
    });
    expect(log.path).toBe(`${dir}/2026-07-25T10-11-12-000Z.jsonl`);
    log.append("claim", { issue: 7, branch: "loop/7-x" });
    log.append("merged", { issue: 7, pr: 12 });
    const lines = (await Bun.file(log.path).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      {
        ts: "2026-07-25T10:11:12.000Z",
        run: "loop-abc-7",
        event: "claim",
        issue: 7,
        branch: "loop/7-x",
      },
      { ts: "2026-07-25T10:11:12.000Z", run: "loop-abc-7", event: "merged", issue: 7, pr: 12 },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unwritable directory never throws — observability doesn't fail a run", () => {
    const log = createRunLog({ dir: "/proc/definitely/not/writable", runId: "r" });
    expect(() => log.append("start")).not.toThrow();
  });

  test("nullRunLog swallows everything and writes no file", () => {
    const log = nullRunLog();
    expect(() => log.append("x", { a: 1 })).not.toThrow();
    expect(log.path).toBe("");
  });
});

describe("makeRunId", () => {
  test("is issue-scoped, sortable and ref-safe", () => {
    const id = makeRunId(42, fixedClock("2026-07-25T10:11:12.000Z"));
    expect(id.endsWith("-42")).toBe(true);
    expect(id).toMatch(/^loop-[0-9a-z]+-42$/);
  });
  test("two issues in the same millisecond still get distinct ids", () => {
    const clock = fixedClock("2026-07-25T10:11:12.000Z");
    expect(makeRunId(1, clock)).not.toBe(makeRunId(2, clock));
  });
});
