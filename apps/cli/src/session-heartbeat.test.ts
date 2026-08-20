// The status file's whole purpose is telling a live run from a wedged one, and the phase where that
// matters most had no heartbeat at all.
//
// An implement session runs for tens of minutes and appends nothing to the run log while it works, so
// the status file went untouched for its entire duration and `hamster status` reported a perfectly
// healthy run as `stale` after 180 seconds. That is worse than no signal: it was believed, and a live
// run's board claim was released out from under it.
import { describe, expect, test } from "bun:test";

import { SESSION_HEARTBEAT_MS } from "./session.ts";
import { classifyStatus } from "./status.ts";

const STALE_AFTER = 180;

const statusAt = (updatedAtMs: number) =>
  ({
    runId: "loop-x-0",
    pid: 1,
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    counts: { claimed: 1, prs: 0, merged: 0, blocked: 0, failed: 0, done: 0 },
    lanes: [{ lane: 0, phase: "implementing", issue: 108, since: new Date(0).toISOString() }],
  }) as never;

describe("session heartbeat interval", () => {
  test("ticks well inside the stale threshold, with room for a slow tick", () => {
    expect(SESSION_HEARTBEAT_MS).toBeLessThan(STALE_AFTER * 1000);
    // At least three ticks fit inside the window, so one missed tick cannot flip a healthy run to stale.
    expect(SESSION_HEARTBEAT_MS * 3).toBeLessThanOrEqual(STALE_AFTER * 1000);
  });

  test("a run heartbeating on that interval never reads as stale", () => {
    const now = 10 * 60 * 1000; // ten minutes into an implement session
    const lastTick = now - SESSION_HEARTBEAT_MS;
    expect(classifyStatus(statusAt(lastTick), now, STALE_AFTER).state).toBe("running");
  });

  test("the regression itself: no heartbeat for a whole session reads as stale", () => {
    const now = 10 * 60 * 1000;
    expect(classifyStatus(statusAt(0), now, STALE_AFTER).state).toBe("stale");
  });
});
