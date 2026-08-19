import { describe, expect, test } from "bun:test";

import type { Config } from "@hamsterwheel/config";

import { Gh } from "./gh.ts";
import { latestWipBranchFor, undraftIfNeeded, waitForChecks } from "./pipeline.ts";

/** Minimal Config surface the functions under test actually read. */
const cfg = (over: Partial<Config> = {}): Config =>
  ({ repo: "acme/repo", ciTimeoutMs: 60_000, ...over }) as Config;

type Call = { args: string[] };

/**
 * A Gh whose exec is driven by a table of [matcher, stdout] pairs, recording every call. Matching on a
 * substring of the joined argv keeps the tests readable without asserting exact flag order.
 */
const fakeGh = (
  routes: [string, string | { exitCode: number; stderr?: string }][],
  calls: Call[] = [],
): Gh =>
  new Gh(async (args: string[]) => {
    calls.push({ args });
    const joined = args.join(" ");
    const hit = routes.find(([m]) => joined.includes(m));
    if (!hit) return { exitCode: 1, stdout: "", stderr: `no route for: ${joined}` };
    const v = hit[1];
    return typeof v === "string"
      ? { exitCode: 0, stdout: v, stderr: "" }
      : { exitCode: v.exitCode, stdout: "", stderr: v.stderr ?? "" };
  });

const rollup = (checks: { name: string; status: string; conclusion?: string }[]): string =>
  JSON.stringify({ statusCheckRollup: checks });

const noSleep = async (): Promise<void> => {};

describe("waitForChecks", () => {
  test("all checks concluded green → green, not timed out", async () => {
    const gh = fakeGh([
      [
        "statusCheckRollup",
        rollup([
          { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
        ]),
      ],
    ]);
    const r = await waitForChecks(gh, cfg(), 7, noSleep);
    expect(r).toMatchObject({ green: true, failing: [] });
    expect(r.timedOut).toBeUndefined();
    expect(r.passing).toEqual(["test", "lint"]);
  });

  test("a concluded failure is reported as a failing check, never as a timeout", async () => {
    const gh = fakeGh([
      [
        "statusCheckRollup",
        rollup([
          { name: "test", status: "COMPLETED", conclusion: "FAILURE" },
          { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
        ]),
      ],
    ]);
    const r = await waitForChecks(gh, cfg(), 7, noSleep);
    expect(r.green).toBe(false);
    expect(r.failing).toEqual(["test"]);
    expect(r.timedOut).toBeUndefined();
  });

  /**
   * The regression: a still-running fleet was reported as `failing: ["<timeout waiting for CI>"]`, which
   * the gate then rendered as `ci-red`. The PR was fine; an operator was sent to debug a failure that did
   * not exist. A timeout must carry no failing checks at all.
   */
  test("running out of time reports timedOut with the pending checks, and NO failing checks", async () => {
    let t = 0;
    const gh = fakeGh([
      [
        "statusCheckRollup",
        rollup([
          { name: "test", status: "IN_PROGRESS" },
          { name: "build", status: "QUEUED" },
          { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
        ]),
      ],
    ]);
    const r = await waitForChecks(
      gh,
      cfg({ ciTimeoutMs: 1 } as Partial<Config>),
      7,
      noSleep,
      () => {
        t += 1000;
        return t;
      },
    );
    expect(r.green).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.failing).toEqual([]);
    expect(r.pending).toEqual(["test", "build"]);
    // Checks that DID conclude green are still reported — the partial signal is real.
    expect(r.passing).toEqual(["lint"]);
  });

  test("skipped checks are ignored when deciding whether everything concluded", async () => {
    const gh = fakeGh([
      [
        "statusCheckRollup",
        rollup([
          { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "deploy", status: "QUEUED", conclusion: "SKIPPED" },
        ]),
      ],
    ]);
    const r = await waitForChecks(gh, cfg(), 7, noSleep);
    expect(r.green).toBe(true);
    expect(r.timedOut).toBeUndefined();
  });
});

describe("undraftIfNeeded", () => {
  /**
   * The regression this closes: #1362 passed CI, two review rounds and the rubric, then died at the
   * final API call on `GraphQL: Pull Request is still a draft`. ~90 minutes of gate work discarded for a
   * reason that has nothing to do with the code.
   */
  test("a draft PR is marked ready before the merge", async () => {
    const calls: Call[] = [];
    const gh = fakeGh(
      [
        ["--json isDraft", "true\n"],
        ["pr ready", ""],
      ],
      calls,
    );
    const logs: string[] = [];
    await undraftIfNeeded(gh, cfg(), 1547, (m) => logs.push(m));
    expect(calls.some((c) => c.args.join(" ").includes("pr ready 1547"))).toBe(true);
    expect(logs.join("\n")).toContain("draft");
  });

  test("a ready PR costs one read and no mutation", async () => {
    const calls: Call[] = [];
    const gh = fakeGh([["--json isDraft", "false\n"]], calls);
    await undraftIfNeeded(gh, cfg(), 1547, () => {});
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.args.includes("ready"))).toBe(false);
  });

  /**
   * An unreadable isDraft must not be guessed at in either direction: skipping the mutation lets the
   * merge below produce the real, specific error rather than this helper inventing one.
   */
  test("an unreadable isDraft does not attempt the mutation", async () => {
    const calls: Call[] = [];
    const gh = fakeGh([], calls);
    await undraftIfNeeded(gh, cfg(), 1547, () => {});
    expect(calls.some((c) => c.args.includes("ready"))).toBe(false);
  });

  test("a failed undraft is logged and swallowed, so the merge still reports the real error", async () => {
    const logs: string[] = [];
    const gh = fakeGh([
      ["--json isDraft", "true\n"],
      ["pr ready", { exitCode: 1, stderr: "no permission" }],
    ]);
    await undraftIfNeeded(gh, cfg(), 1547, (m) => logs.push(m));
    expect(logs.join("\n")).toContain("could not undraft");
  });
});

describe("latestWipBranchFor", () => {
  // The selection reads real branches via git, so this file covers the two halves separately: the
  // no-candidates default here, and the naming/ordering contract it depends on in the next block.
  test("no matching branch yields undefined rather than a throw", async () => {
    // branchPrefix pointing at a prefix no branch uses: the lookup succeeds and matches nothing.
    const r = await latestWipBranchFor({ branchPrefix: "no-such-prefix-xyz" } as never, 999_999);
    expect(r).toBeUndefined();
  });
});

describe("wip branch shapes (contract latestWipBranchFor depends on)", () => {
  const RESUMABLE = /^loop-([0-9a-z]+)-\d+$/;

  /**
   * The hazard: acquireLane salvages a lane's LEFTOVERS under the INCOMING issue's number, so
   * `loop/1371-wip-lane0-recovered-loop-<ts>-1371` can contain issue #1362's work. Resuming it would
   * graft one issue's abandoned changes onto another issue's branch.
   */
  test("a lane-recovered salvage is NOT a resumable run id", () => {
    expect(RESUMABLE.test("lane0-recovered-loop-msqmb2fa-1371")).toBe(false);
    expect(RESUMABLE.test("lane12-recovered-loop-msqmb2fa-1371")).toBe(false);
  });

  test("a claim-time salvage IS a resumable run id", () => {
    expect(RESUMABLE.test("loop-msqmb2fa-1518")).toBe(true);
  });

  /**
   * Ordering must come from the parsed base36 timestamp, not from sorting branch names: the two
   * shapes share no common prefix, so name order compares "lane…" against "loop…" and decides on
   * the letter 'a' vs 'o' long before reaching any timestamp.
   */
  test("base36 run-id timestamps order numerically, and name order disagrees", () => {
    const older = "loop-msqmb2fa-1";
    const newer = "loop-msrclx6y-1";
    const ts = (r: string): number => Number.parseInt(RESUMABLE.exec(r)![1]!, 36);
    expect(ts(newer)).toBeGreaterThan(ts(older));

    // Same-length base36 happens to sort correctly among itself...
    expect([newer, older].toSorted().at(-1)).toBe(newer);
    // ...but mixing in the other shape breaks name ordering outright.
    expect(
      ["loop/1-wip-loop-msqmb2fa-1", "loop/1-wip-lane0-recovered-loop-msrclx6y-1"]
        .toSorted()
        .at(-1),
    ).toBe("loop/1-wip-loop-msqmb2fa-1");
  });
});
