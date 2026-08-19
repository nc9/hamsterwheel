import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type LoopStatus,
  classifyStatus,
  createStatus,
  nullStatus,
  readStatus,
  runDirFor,
} from "./status.ts";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "hamster-status-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const mk = (dir: string, over: Partial<Parameters<typeof createStatus>[0]> = {}) =>
  createStatus({
    dir,
    runId: "loop-abc-0",
    repo: "acme/backend",
    command: "run",
    execute: true,
    lanes: 1,
    ...over,
  });

describe("runDirFor", () => {
  /**
   * The regression: every repo's runs landed in one flat directory, so "the current run" meant
   * `ls -t | head -1` — which silently returns a DIFFERENT repo's run as soon as two loops exist.
   */
  test("scopes the run directory per repo", () => {
    expect(runDirFor("/h", "acme/backend")).toBe("/h/.hamsterwheel/runs/acme-backend");
    expect(runDirFor("/h", "acme/frontend")).toBe("/h/.hamsterwheel/runs/acme-frontend");
    expect(runDirFor("/h", "acme/backend")).not.toBe(runDirFor("/h", "acme/frontend"));
  });
});

describe("createStatus", () => {
  test("writes a readable status file immediately, before any work happens", () => {
    const d = tmp();
    const w = mk(d);
    const s = readStatus(d);
    expect(s).not.toBeNull();
    expect(s?.runId).toBe("loop-abc-0");
    expect(s?.repo).toBe("acme/backend");
    expect(s?.lanes).toHaveLength(1);
    expect(s?.lanes[0]).toMatchObject({ lane: 0, issue: null, phase: "idle" });
    expect(w.path).toBe(`${d}/current.json`);
  });

  test("one lane entry per configured lane", () => {
    const d = tmp();
    mk(d, { lanes: 3 });
    expect(readStatus(d)?.lanes.map((l) => l.lane)).toEqual([0, 1, 2]);
  });

  test("phase moves a single lane and records the issue", () => {
    const d = tmp();
    const w = mk(d, { lanes: 2 });
    w.phase(1, "implementing", { issue: 42, detail: "loop/42-thing" });
    const s = readStatus(d);
    expect(s?.lanes[0]).toMatchObject({ lane: 0, phase: "idle", issue: null });
    expect(s?.lanes[1]).toMatchObject({ lane: 1, phase: "implementing", issue: 42 });
    expect(s?.lanes[1]?.detail).toBe("loop/42-thing");
  });

  /**
   * `since` is phase ENTRY time. If a heartbeat reset it, a phase wedged for an hour would look
   * freshly entered forever — which is the exact thing this file exists to surface.
   */
  test("a heartbeat refreshes updatedAt but never the phase's since", async () => {
    const d = tmp();
    const w = mk(d);
    w.phase(0, "ci-wait", { issue: 7 });
    const first = readStatus(d)!;
    await new Promise((r) => setTimeout(r, 5));
    w.heartbeat();
    const second = readStatus(d)!;
    expect(second.lanes[0]?.since).toBe(first.lanes[0]!.since);
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt));
  });

  test("re-entering the same phase does not reset since", async () => {
    const d = tmp();
    const w = mk(d);
    w.phase(0, "ci-wait", { issue: 7 });
    const first = readStatus(d)!.lanes[0]!.since;
    await new Promise((r) => setTimeout(r, 5));
    w.phase(0, "ci-wait", { issue: 7 });
    expect(readStatus(d)!.lanes[0]!.since).toBe(first);
  });

  test("counters accumulate", () => {
    const d = tmp();
    const w = mk(d);
    w.count("claimed");
    w.count("claimed");
    w.count("merged");
    expect(readStatus(d)?.counts).toMatchObject({ claimed: 2, merged: 1, blocked: 0 });
  });

  test("finish stamps endedAt and idles every lane", () => {
    const d = tmp();
    const w = mk(d, { lanes: 2 });
    w.phase(0, "implementing", { issue: 1 });
    w.finish();
    const s = readStatus(d)!;
    expect(s.endedAt).toBeTruthy();
    expect(s.lanes.every((l) => l.issue === null)).toBe(true);
  });

  test("the file is always complete JSON — never a torn partial write", () => {
    const d = tmp();
    const w = mk(d);
    for (let i = 0; i < 25; i++) w.count("claimed");
    // A reader polling on its own schedule must never catch a half-written file.
    expect(() => JSON.parse(readFileSync(`${d}/current.json`, "utf8"))).not.toThrow();
  });
});

describe("nullStatus", () => {
  /** Read-only commands must not leave a status file implying a run happened. */
  test("writes nothing anywhere", () => {
    const d = tmp();
    const w = nullStatus();
    w.phase(0, "implementing", { issue: 1 });
    w.count("merged");
    w.finish();
    expect(readStatus(d)).toBeNull();
    expect(w.path).toBe("");
  });
});

describe("readStatus", () => {
  test("a missing file reads as null, not a throw", () => {
    expect(readStatus(tmp())).toBeNull();
  });

  test("a corrupt file reads as null, not a throw", () => {
    const d = tmp();
    writeFileSync(`${d}/current.json`, "{ not json");
    expect(readStatus(d)).toBeNull();
  });

  /** A file that parses but is not a status object must not be trusted as one. */
  test("valid JSON of the wrong shape reads as null", () => {
    const d = tmp();
    writeFileSync(`${d}/current.json`, JSON.stringify({ hello: "world" }));
    expect(readStatus(d)).toBeNull();
  });
});

describe("classifyStatus", () => {
  const base: LoopStatus = {
    runId: "loop-abc-0",
    pid: 1234,
    repo: "acme/backend",
    command: "run",
    execute: true,
    startedAt: "2026-08-19T09:00:00.000Z",
    updatedAt: "2026-08-19T09:00:00.000Z",
    lanes: [{ lane: 0, issue: 42, phase: "implementing", since: "2026-08-19T09:00:00.000Z" }],
    counts: { claimed: 1, prsOpened: 0, merged: 0, blocked: 0, failed: 0, done: 0 },
  };
  const at = (iso: string) => Date.parse(iso);

  test("no status file at all is idle", () => {
    expect(classifyStatus(null, at("2026-08-19T09:00:00.000Z")).state).toBe("idle");
  });

  test("a recent heartbeat is running, and names the lane and phase", () => {
    const v = classifyStatus(base, at("2026-08-19T09:00:30.000Z"));
    expect(v.state).toBe("running");
    expect(v.staleSeconds).toBe(30);
    expect(v.detail).toContain("lane-0");
    expect(v.detail).toContain("#42");
    expect(v.detail).toContain("implementing");
  });

  /**
   * The whole point: a run that stopped appending is indistinguishable from a slow one UNLESS the
   * heartbeat ages out. 10 minutes with no beat is a dead or wedged run, not a slow CI queue.
   */
  test("a heartbeat older than the threshold is stale", () => {
    const v = classifyStatus(base, at("2026-08-19T09:10:00.000Z"));
    expect(v.state).toBe("stale");
    expect(v.detail).toContain("1234"); // the pid, so a human can go look
  });

  test("the stale threshold is configurable and inclusive of slow ticks", () => {
    // 120s must NOT be stale at the 180s default — a single slow poll is not death.
    expect(classifyStatus(base, at("2026-08-19T09:02:00.000Z")).state).toBe("running");
    expect(classifyStatus(base, at("2026-08-19T09:02:00.000Z"), 60).state).toBe("stale");
  });

  test("an ended run is 'ended', never 'stale', however long ago it finished", () => {
    const ended = { ...base, endedAt: "2026-08-19T09:05:00.000Z" };
    const v = classifyStatus(ended, at("2026-08-19T12:00:00.000Z"));
    expect(v.state).toBe("ended");
    expect(v.detail).toContain("finished");
  });

  test("an unparseable updatedAt is stale, not running", () => {
    const v = classifyStatus({ ...base, updatedAt: "nonsense" }, at("2026-08-19T09:00:30.000Z"));
    expect(v.state).toBe("stale");
    expect(v.staleSeconds).toBeNull();
  });

  test("running with every lane idle says so rather than naming a phantom issue", () => {
    const idle = {
      ...base,
      lanes: [{ lane: 0, issue: null, phase: "idle" as const, since: base.startedAt }],
    };
    const v = classifyStatus(idle, at("2026-08-19T09:00:10.000Z"));
    expect(v.state).toBe("running");
    expect(v.detail).toContain("no lane");
  });
});
