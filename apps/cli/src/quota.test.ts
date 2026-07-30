// Quota exhaustion is run-fatal and MISREAD as a broken board, so these assert two things: the verdict
// never reports an unknown or malformed quota as healthy, and the pool that wedges the loop (GraphQL) is
// the one named in the failure.
import { describe, expect, test } from "bun:test";

import { runFatalReason } from "./errors.ts";
import { preflightProblems } from "./preflight.ts";
import {
  DEFAULT_GRAPHQL_FLOOR,
  GRAPHQL_WARN_AT,
  PIPELINE_COST,
  type RateLimits,
  estimateQueueBuildCost,
  estimateRunCost,
  formatReset,
  quotaVerdict,
} from "./quota.ts";
import { parseConfig } from "@hamsterwheel/config";

const NOW = 1_785_377_830;
const limits = (over: {
  graphql?: Partial<RateLimits["graphql"]>;
  core?: Partial<RateLimits["core"]>;
}): RateLimits => ({
  graphql: { limit: 5000, remaining: 5000, used: 0, resetAt: NOW + 1800, ...over.graphql },
  core: { limit: 5000, remaining: 5000, used: 0, resetAt: NOW + 1800, ...over.core },
});

const verdict = (l: RateLimits | null, floor?: number) =>
  quotaVerdict(l, { nowSeconds: NOW, ...(floor === undefined ? {} : { graphqlFloor: floor }) });

describe("formatReset", () => {
  test("sub-minute, minutes and hours", () => {
    expect(formatReset(0)).toBe("now");
    expect(formatReset(-5)).toBe("now");
    expect(formatReset(45)).toBe("45s");
    expect(formatReset(2314)).toBe("39m");
    expect(formatReset(7200)).toBe("2h 0m");
  });
});

describe("cost model", () => {
  test("startup is dominated by TOTAL board size, not by the Ready count", () => {
    // The bug this encodes: costing only the Ready items under-predicted a real run by ~35x.
    expect(estimateQueueBuildCost(415, 14)).toBeGreaterThan(1000);
    // Same tiny queue, big board — still expensive, because listItems reads every item.
    expect(estimateQueueBuildCost(415, 1)).toBeGreaterThan(estimateQueueBuildCost(20, 14));
  });
  test("matches the measured 415-item run within 10%", () => {
    // Observed: 1982 → 731 = 1251 points for startup on a 415-item board with 14 Ready.
    const est = estimateQueueBuildCost(415, 14);
    expect(Math.abs(est - 1251) / 1251).toBeLessThan(0.1);
  });
  test("negative or zero counts are nonsense input, not a discount", () => {
    expect(estimateQueueBuildCost(0, 0)).toBe(0);
    expect(estimateQueueBuildCost(-10, -5)).toBe(0);
  });
  test("a run costs the startup plus at least one pipeline", () => {
    expect(estimateRunCost(100, 10)).toBe(estimateQueueBuildCost(100, 10) + PIPELINE_COST);
    expect(estimateRunCost(100, 10, 3)).toBe(estimateQueueBuildCost(100, 10) + 3 * PIPELINE_COST);
    expect(estimateRunCost(100, 10, 0)).toBe(estimateQueueBuildCost(100, 10) + PIPELINE_COST);
  });
  test("the preflight floor covers the measured board, so a doomed run cannot start", () => {
    // The old floor was 128 — a run with 200 points left passed preflight and died mid-build.
    expect(DEFAULT_GRAPHQL_FLOOR).toBeGreaterThan(1251);
  });
});

describe("quotaVerdict", () => {
  test("a healthy pair is ok and reports both pools", () => {
    const v = verdict(limits({}));
    expect(v.level).toBe("ok");
    expect(v.exhausted).toBeUndefined();
    expect(v.detail).toContain("GraphQL");
    expect(v.detail).toContain("REST core");
  });

  test("a failed read is UNKNOWN, never healthy — and never fatal either", () => {
    const v = verdict(null);
    expect(v.level).toBe("warn");
    expect(v.exhausted).toBeUndefined();
    expect(v.detail).toContain("UNKNOWN");
    expect(v.detail).toContain("not verified");
  });

  test("exhausted GraphQL fails, names the pool, and says when it clears", () => {
    // The real numbers from the incident: 58 of 5000 left, ~39 minutes to reset.
    const v = verdict(limits({ graphql: { remaining: 58, used: 4942, resetAt: NOW + 2314 } }));
    expect(v.level).toBe("fail");
    expect(v.exhausted).toBe("graphql");
    expect(v.detail).toContain("39m");
  });

  test("the GraphQL failure explicitly says healthy REST is not a counter-signal", () => {
    // The whole misdiagnosis: `gh issue`/`gh pr` keep working, so the operator concludes the board broke.
    const v = verdict(limits({ graphql: { remaining: 0 }, core: { remaining: 4998 } }));
    expect(v.detail).toMatch(/not a broken board/i);
    expect(v.detail).toContain("4998");
  });

  test("GraphQL is judged before core, since it is the pool that wedges the board", () => {
    expect(verdict(limits({ graphql: { remaining: 0 }, core: { remaining: 0 } })).exhausted).toBe(
      "graphql",
    );
  });

  test("exhausted REST core fails on its own", () => {
    const v = verdict(limits({ core: { remaining: 3 } }));
    expect(v.level).toBe("fail");
    expect(v.exhausted).toBe("core");
  });

  test("a malformed payload reads as exhausted, not as full", () => {
    // remaining defaults to 0 rather than to `limit` — the safe direction for a missing field.
    const v = verdict({
      graphql: { limit: 0, remaining: 0, used: 0, resetAt: 0 },
      core: { limit: 0, remaining: 0, used: 0, resetAt: 0 },
    });
    expect(v.level).toBe("fail");
  });

  test("low-but-sufficient warns without blocking", () => {
    const v = verdict(limits({ graphql: { remaining: 1600 } }));
    expect(v.level).toBe("warn");
    expect(v.exhausted).toBeUndefined();
  });

  test("the warn band sits above the floor, or it is unreachable", () => {
    expect(GRAPHQL_WARN_AT).toBeGreaterThan(DEFAULT_GRAPHQL_FLOOR);
  });

  test("below the startup floor, the warn names the NEXT run as the constraint", () => {
    // Production wording bug: at 731 left it said "room for roughly 36 more of these", dividing by the
    // caller's floor. The real constraint is that a fresh run cannot read the board at all.
    const v = verdict(limits({ graphql: { remaining: 731 } }), PIPELINE_COST);
    expect(v.level).toBe("warn");
    expect(v.detail).toMatch(/fresh run needs/i);
    expect(v.detail).not.toMatch(/more of these/);
  });

  test("the floor is what decides, so the pre-claim check passes where preflight would fail", () => {
    const nearlyDry = limits({ graphql: { remaining: PIPELINE_COST + 5 } });
    // Before the queue is built, that is not enough to rank a 50-item board.
    expect(verdict(nearlyDry, DEFAULT_GRAPHQL_FLOOR).level).toBe("fail");
    // Mid-run the queue is already paid for, so only this issue's pipeline is still owed.
    expect(verdict(nearlyDry, PIPELINE_COST).level).not.toBe("fail");
  });
});

describe("quota reaches the run-fatal paths", () => {
  const cfg = parseConfig(
    Bun.TOML.parse(`
repo = "acme/backend"
[[human]]
name = "prod-migration"
paths = "(^|/)drizzle/"
[project]
number = 1
`),
    { home: "/home/ci" },
  );
  const base = {
    cfg,
    sandbox: false,
    env: { HOME: "/home/ci" },
    which: (b: string) => `/usr/local/bin/${b}`,
  };

  test("an exhausted pool is a preflight problem that refuses the start", () => {
    const problems = preflightProblems({
      ...base,
      quota: verdict(limits({ graphql: { remaining: 0 } })),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.check).toBe("api-quota (graphql)");
    // The hint must stop the operator debugging the board.
    expect(problems[0]!.hint).toMatch(/wait for the reset/i);
  });

  test("a warn or an unknown quota does not block the start", () => {
    expect(
      preflightProblems({ ...base, quota: verdict(limits({ graphql: { remaining: 1600 } })) }),
    ).toEqual([]);
    expect(preflightProblems({ ...base, quota: verdict(null) })).toEqual([]);
    expect(preflightProblems(base)).toEqual([]);
  });

  test("a rate-limit error thrown mid-pipeline classifies as run-fatal, not issue-fatal", () => {
    // Left unclassified, a quota wall would Block each item in the queue in turn for an account condition.
    expect(
      runFatalReason(
        new Error(
          "gh project field-list 1 failed (1): GraphQL: API rate limit exceeded for user ID 39009487.",
        ),
      ),
    ).toMatch(/api-quota/);
    expect(runFatalReason(new Error("You have exceeded a secondary rate limit"))).toMatch(
      /api-quota/,
    );
    expect(runFatalReason(new Error("HTTP 429: Too Many Requests"))).toMatch(/api-quota/);
    // Still not a catch-all: an ordinary failure stays issue-fatal.
    expect(runFatalReason(new Error("tests failed: 3 assertions"))).toBeNull();
  });
});
