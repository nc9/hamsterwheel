import { $ } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "@hamsterwheel/config";

import type { BoardCtx } from "./board.ts";
import { type ExecResult, Gh, type GhExec } from "./gh.ts";
import { release } from "./release.ts";

const cfg = parseConfig(
  {
    repo: "acme/backend",
    project: { number: 7 },
    human: [{ name: "prod-migration", paths: "(^|/)drizzle/" }],
  },
  { home: "/home/ci" },
);

const ctx: BoardCtx = {
  projectNumber: 7,
  projectId: "PVT_1",
  owner: "acme",
  statusFieldId: "F_status",
  ownerFieldId: "F_owner",
  statusFieldName: "Status",
  ownerFieldName: "Owner",
  blockedFieldId: null,
  statusOptions: {},
  blockedOptions: {},
};

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
const bad = (stderr: string): ExecResult => ({ stdout: "", stderr, exitCode: 1 });

type Fixture = {
  /** Board Done items: issue number → state answered by `gh issue view` ("fail" = lookup fails). */
  done: Record<number, "CLOSED" | "OPEN" | "fail">;
  /** PR number → closed issues, answered by the batched closingIssuesReferences query. */
  closes?: Record<number, number[]>;
};

const fakeGh = (fx: Fixture) => {
  const calls: string[][] = [];
  const exec: GhExec = async (args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === "project" && b === "item-list")
      return ok(
        JSON.stringify({
          items: Object.keys(fx.done).map((n) => ({
            id: `I_${n}`,
            title: `t${n}`,
            status: "Done",
            content: { number: Number(n), repository: "acme/backend", title: `t${n}` },
          })),
        }),
      );
    if (a === "issue" && b === "view") {
      const state = fx.done[Number(args[2])];
      return !state || state === "fail" ? bad("boom") : ok(`${state}\n`);
    }
    if (a === "api" && b === "graphql") {
      const q = args.find((x) => x.startsWith("query=")) ?? "";
      if (q.includes("archiveProjectV2Item"))
        return ok(JSON.stringify({ data: { archiveProjectV2Item: { item: { id: "x" } } } }));
      if (q.includes("closingIssuesReferences"))
        return ok(
          JSON.stringify({
            data: {
              repository: Object.fromEntries(
                Object.entries(fx.closes ?? {}).map(([pr, issues]) => [
                  `pr${pr}`,
                  { closingIssuesReferences: { nodes: issues.map((number) => ({ number })) } },
                ]),
              ),
            },
          }),
        );
      return bad(`unexpected graphql: ${q.slice(0, 80)}`);
    }
    if (a === "release" && b === "create")
      return ok(`https://github.com/acme/backend/releases/tag/${args[2]}\n`);
    return bad(`unexpected gh call: ${args.join(" ")}`);
  };
  return { gh: new Gh(exec), calls };
};

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/** A repo that is its own `origin`, so fetch/revParse of origin/main work without a network. */
const initRepo = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "hw-release-"));
  tmp.push(dir);
  const g = async (...args: string[]) =>
    $`git -C ${dir} -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${args}`.quiet();
  await g("init", "-b", "main");
  await g("commit", "--allow-empty", "-m", "feat(cli): first thing (#1)");
  await g("tag", "v0.1.0");
  await g("commit", "--allow-empty", "-m", "fix(auth): login loop (#2)");
  await g("commit", "--allow-empty", "-m", "chore: tidy");
  await g("remote", "add", "origin", dir);
  return dir;
};

/** The git helpers run in process.cwd(), so pin it to the fixture repo for the duration. */
const inRepo = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
};

const noop = () => {};

describe("release (tag arm)", () => {
  test("dry run derives prev tag, notes, bump and the archive plan — and mutates nothing", async () => {
    const dir = await initRepo();
    const { gh, calls } = fakeGh({ done: { 20: "CLOSED", 99: "CLOSED" }, closes: { 2: [20] } });
    const r = await inRepo(dir, () =>
      release(
        { gh, cfg, ctx, log: noop, cwd: dir },
        { execute: false, changelog: false, archiveDone: false, date: "2026-07-27" },
      ),
    );
    expect(r.previousTag).toBe("v0.1.0");
    expect(r.suggested).toEqual({ level: "patch", next: "v0.1.1" });
    expect(r.tag).toBe("v0.1.1");
    expect(r.notes).toContain("### Fixes");
    expect(r.notes).toContain("- **auth**: login loop (#2; closes #20)");
    // #99 is Done but not closed by any PR in the range — it is NOT part of this release.
    expect(r.archive.planned).toEqual([{ issue: 20, itemId: "I_20" }]);
    expect(r.dryRun).toBe(true);
    expect(calls.some((c) => c[0] === "release")).toBe(false);
    expect(calls.some((c) => c.join(" ").includes("archiveProjectV2Item"))).toBe(false);
  });

  test("--execute cuts the release, archives the shipped items, writes CHANGELOG.md", async () => {
    const dir = await initRepo();
    const { gh, calls } = fakeGh({ done: { 20: "CLOSED" }, closes: { 2: [20] } });
    const r = await inRepo(dir, () =>
      release(
        { gh, cfg, ctx, log: noop, cwd: dir },
        { execute: true, tag: "v0.2.0", changelog: true, archiveDone: false, date: "2026-07-27" },
      ),
    );
    expect(r.release?.url).toContain("/releases/tag/v0.2.0");
    const create = calls.find((c) => c[0] === "release" && c[1] === "create")!;
    expect(create[2]).toBe("v0.2.0");
    // Pinned to the REMOTE base tip, never the local checkout.
    expect(create).toContain("--target");
    expect(r.archive.archived).toEqual([{ issue: 20, ok: true }]);
    expect(await readFile(join(dir, "CHANGELOG.md"), "utf8")).toContain("## v0.2.0 — 2026-07-27");
  });

  test("a non-semver tag is refused — the derivation would never see it again", async () => {
    const dir = await initRepo();
    const { gh } = fakeGh({ done: {} });
    await expect(
      inRepo(dir, () =>
        release(
          { gh, cfg, ctx, log: noop, cwd: dir },
          { execute: true, tag: "latest", changelog: false, archiveDone: false, date: "2026-07-27" },
        ),
      ),
    ).rejects.toThrow("plain semver");
  });

  test("an existing tag is refused, never overwritten", async () => {
    const dir = await initRepo();
    const { gh } = fakeGh({ done: {} });
    await expect(
      inRepo(dir, () =>
        release(
          { gh, cfg, ctx, log: noop, cwd: dir },
          { execute: true, tag: "v0.1.0", changelog: false, archiveDone: false, date: "2026-07-27" },
        ),
      ),
    ).rejects.toThrow("already exists");
  });
});

describe("release (--archive-done backfill)", () => {
  test("archives closed, keeps unconfirmed — a failed lookup is not a passed check", async () => {
    const { gh } = fakeGh({ done: { 5: "CLOSED", 6: "fail", 7: "OPEN" } });
    const r = await release(
      { gh, cfg, ctx, log: noop },
      { execute: true, changelog: false, archiveDone: true, date: "2026-07-27" },
    );
    expect(r.archive.planned.map((p) => p.issue).sort()).toEqual([5, 6, 7]);
    expect(r.archive.archived).toEqual([{ issue: 5, ok: true }]);
    expect(r.archive.kept.map((k) => k.issue).sort()).toEqual([6, 7]);
    expect(r.notes).toBeNull();
  });

  test("dry run only plans", async () => {
    const { gh, calls } = fakeGh({ done: { 5: "CLOSED" } });
    const r = await release(
      { gh, cfg, ctx, log: noop },
      { execute: false, changelog: false, archiveDone: true, date: "2026-07-27" },
    );
    expect(r.archive.planned).toEqual([{ issue: 5, itemId: "I_5" }]);
    expect(r.archive.archived).toEqual([]);
    expect(calls.some((c) => c.join(" ").includes("archiveProjectV2Item"))).toBe(false);
  });
});
