import { $ } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "@hamsterwheel/config";

import { worktreeReadiness } from "./doctor.ts";
import {
  acquireLane,
  copyIncludes,
  globToRegExp,
  laneDir,
  listIncludeFiles,
  parseWorktreeInclude,
  releaseLane,
  uncoveredEnvFiles,
} from "./lanes.ts";

const cfgFor = (worktreeRoot: string, over: Record<string, unknown> = {}) =>
  parseConfig(
    {
      repo: "acme/backend",
      worktree_root: worktreeRoot,
      project: { number: 1 },
      human: [{ name: "prod-migration", paths: "(^|/)drizzle/" }],
      scripts: { setup: "true" }, // a no-op binary: setup must not dominate the test
      ...over,
    },
    { home: "/home/ci" },
  );

describe("laneDir", () => {
  test("scopes by repo slug under the global worktree root", () => {
    expect(laneDir(cfgFor("/wt"), 0)).toBe("/wt/acme-backend/lane-0");
    expect(laneDir(cfgFor("/wt"), 4)).toBe("/wt/acme-backend/lane-4");
  });
});

describe("parseWorktreeInclude", () => {
  test("skips blanks and comments, trims whitespace", () => {
    expect(parseWorktreeInclude("# env files\n.env\n\n  .env.*  \n#x\n.dev.vars\n")).toEqual([
      ".env",
      ".env.*",
      ".dev.vars",
    ]);
  });
  test("empty file → no patterns", () => {
    expect(parseWorktreeInclude("")).toEqual([]);
    expect(parseWorktreeInclude("# only a comment\n")).toEqual([]);
  });
});

describe("globToRegExp", () => {
  const hits = (pattern: string, path: string) => globToRegExp(pattern).test(path);
  test("bare name matches at any depth (gitignore semantics)", () => {
    expect(hits(".env", ".env")).toBe(true);
    expect(hits(".env", "apps/web/.env")).toBe(true);
    expect(hits(".env", ".env.local")).toBe(false);
    expect(hits(".env", "some.env")).toBe(false);
  });
  test("* stays within a segment", () => {
    expect(hits(".env.*", ".env.local")).toBe(true);
    expect(hits(".env.*", "apps/web/.env.production")).toBe(true);
    expect(hits(".env.*", ".env")).toBe(false);
    expect(hits("*.vars", ".dev.vars")).toBe(true);
    expect(hits("*.vars", "a/b.vars")).toBe(true);
  });
  test("a pattern containing / is anchored to the repo root", () => {
    expect(hits("config/local.json", "config/local.json")).toBe(true);
    expect(hits("config/local.json", "apps/config/local.json")).toBe(false);
  });
  test("** crosses segments; trailing / means everything under", () => {
    expect(hits("config/local/**", "config/local/a/b.json")).toBe(true);
    expect(hits("config/local/**", "config/other/a.json")).toBe(false);
    expect(hits("secrets/", "secrets/k.pem")).toBe(true);
    expect(hits("secrets/", "secrets/deep/k.pem")).toBe(true);
    expect(hits("secrets/", "other/k.pem")).toBe(false);
  });
  test("**/ matches zero or more directories (gitignore semantics)", () => {
    expect(hits("**/.env", ".env")).toBe(true);
    expect(hits("**/.env", "apps/web/.env")).toBe(true);
    expect(hits("config/**/local.json", "config/local.json")).toBe(true);
    expect(hits("config/**/local.json", "config/a/b/local.json")).toBe(true);
    expect(hits("config/**/local.json", "other/local.json")).toBe(false);
  });
  test("? matches exactly one non-slash char; regex specials are literal", () => {
    expect(hits(".env.?", ".env.a")).toBe(true);
    expect(hits(".env.?", ".env.ab")).toBe(false);
    expect(hits("a+b.txt", "a+b.txt")).toBe(true);
    expect(hits("a+b.txt", "aab.txt")).toBe(false); // "+" is not a regex quantifier here
  });
});

describe("listIncludeFiles / copyIncludes", () => {
  const root = mkdtempSync(join(tmpdir(), "hw-inc-"));
  const lane = mkdtempSync(join(tmpdir(), "hw-lane-"));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(lane, { recursive: true, force: true });
  });

  test("walks nested dirs, skips .git and node_modules, copies preserving paths", async () => {
    await mkdir(join(root, "apps/web"), { recursive: true });
    await mkdir(join(root, "node_modules/dep"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".env"), "TOP=1\n");
    await writeFile(join(root, "apps/web/.env"), "WEB=1\n");
    await writeFile(join(root, "node_modules/dep/.env"), "NO\n");
    await writeFile(join(root, ".git/.env"), "NO\n");
    await writeFile(join(root, "README.md"), "no\n");
    await writeFile(join(root, ".worktreeinclude"), "# env\n.env\n");

    expect(await listIncludeFiles(root, [".env"])).toEqual([".env", "apps/web/.env"]);

    const copied = await copyIncludes(root, lane);
    expect(copied).toEqual([".env", "apps/web/.env"]);
    expect(await readFile(join(lane, "apps/web/.env"), "utf8")).toBe("WEB=1\n");
  });

  test("no .worktreeinclude → no-op; empty patterns → no walk", async () => {
    const bare = mkdtempSync(join(tmpdir(), "hw-bare-"));
    expect(await copyIncludes(bare, lane)).toEqual([]);
    expect(await listIncludeFiles(bare, [])).toEqual([]);
    rmSync(bare, { recursive: true, force: true });
  });
});

describe("uncoveredEnvFiles / worktreeReadiness", () => {
  test("uncoveredEnvFiles reports what no pattern matches", () => {
    expect(uncoveredEnvFiles([".env", "apps/web/.env.local"], [".env", ".env.*"])).toEqual([]);
    expect(uncoveredEnvFiles([".env", ".dev.vars"], [".env"])).toEqual([".dev.vars"]);
    expect(uncoveredEnvFiles([".env"], [])).toEqual([".env"]);
  });

  test("readiness: warn on uncovered env files, ok when covered or none exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "hw-ready-"));
    try {
      // No env files, no include file → nothing to do.
      expect((await worktreeReadiness(root)).status).toBe("ok");

      // An env file with no .worktreeinclude → warn naming it.
      await writeFile(join(root, ".env"), "A=1\n");
      const warn = await worktreeReadiness(root);
      expect(warn.status).toBe("warn");
      expect(warn.detail).toContain(".env");

      // Covered → ok.
      await writeFile(join(root, ".worktreeinclude"), ".env\n");
      expect((await worktreeReadiness(root)).status).toBe("ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---- lane lifecycle against a real repo (same pattern as gate's salvage tests) ------------------

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/** A bare "origin" plus a primary clone, so origin/<base> exists (and is pushable) like in production. */
const initRepoWithOrigin = async (): Promise<{ origin: string; primary: string }> => {
  const seed = mkdtempSync(join(tmpdir(), "hw-seed-"));
  const origin = mkdtempSync(join(tmpdir(), "hw-origin-"));
  const primary = mkdtempSync(join(tmpdir(), "hw-primary-"));
  tmp.push(seed, origin, primary);
  await $`git -C ${seed} init -q -b main`.quiet();
  await $`git -C ${seed} config user.email hw@test`.quiet();
  await $`git -C ${seed} config user.name hw`.quiet();
  await Bun.write(join(seed, "base.txt"), "base\n");
  await $`git -C ${seed} add -A`.quiet();
  await $`git -C ${seed} commit -q -m base`.quiet();
  await $`git clone -q --bare ${seed} ${origin}/o.git`.quiet();
  await $`git clone -q ${origin}/o.git ${primary}/repo`.quiet();
  await $`git -C ${primary}/repo config user.email hw@test`.quiet();
  await $`git -C ${primary}/repo config user.name hw`.quiet();
  return { origin: `${origin}/o.git`, primary: `${primary}/repo` };
};

describe("acquireLane / releaseLane", () => {
  test("cold acquire creates the worktree; re-acquire reuses it and keeps ignored files", async () => {
    const { primary } = await initRepoWithOrigin();
    const wtRoot = mkdtempSync(join(tmpdir(), "hw-lanes-"));
    tmp.push(wtRoot);
    const cfg = cfgFor(wtRoot);
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    const prevCwd = process.cwd();
    process.chdir(primary); // fetchBase/pruneWorktrees run in the driver's cwd (the primary checkout)
    try {
      const a1 = await acquireLane({
        cfg,
        lane: 0,
        branch: "loop/1-first",
        issueNumber: 1,
        runId: "r1",
        repoRoot: primary,
        log,
      });
      expect(a1.created).toBe(true);
      expect(a1.recovered).toBeNull();
      const branch1 = (await $`git -C ${a1.dir} branch --show-current`.text()).trim();
      expect(branch1).toBe("loop/1-first");
      // The load-bearing upstream drop: an unpinned push must not resolve to the base branch.
      expect(
        (await $`git -C ${a1.dir} rev-parse --abbrev-ref @{upstream}`.nothrow().quiet()).exitCode,
      ).not.toBe(0);

      await releaseLane(cfg, 0);
      expect((await $`git -C ${a1.dir} branch --show-current`.text()).trim()).toBe(""); // detached

      const a2 = await acquireLane({
        cfg,
        lane: 0,
        branch: "loop/2-second",
        issueNumber: 2,
        runId: "r2",
        repoRoot: primary,
        log,
      });
      expect(a2.created).toBe(false);
      expect(a2.dir).toBe(a1.dir);
      expect((await $`git -C ${a2.dir} branch --show-current`.text()).trim()).toBe("loop/2-second");
      const status = (await $`git -C ${a2.dir} status --porcelain`.text()).trim();
      expect(status).toBe(""); // lane is pristine for the new issue
      expect(a2.recovered).toBeNull(); // a clean lane triggers no salvage
    } finally {
      process.chdir(prevCwd);
    }
  });

  test("a dirty lane is salvaged to a WIP branch before reset — nothing is destroyed", async () => {
    const { primary } = await initRepoWithOrigin();
    const wtRoot = mkdtempSync(join(tmpdir(), "hw-lanes2-"));
    tmp.push(wtRoot);
    const cfg = cfgFor(wtRoot);
    const log = () => {};

    const prevCwd = process.cwd();
    process.chdir(primary);
    try {
      const a1 = await acquireLane({
        cfg,
        lane: 0,
        branch: "loop/3-crash",
        issueNumber: 3,
        runId: "r3",
        repoRoot: primary,
        log,
      });
      // Crash mid-session: tracked edit + untracked file, driver dies (no salvage, no release).
      await Bun.write(join(a1.dir, "base.txt"), "edited by crashed session\n");
      await Bun.write(join(a1.dir, "new-feature.ts"), "unfinished\n");

      const a2 = await acquireLane({
        cfg,
        lane: 0,
        branch: "loop/4-next",
        issueNumber: 4,
        runId: "r4",
        repoRoot: primary,
        log,
      });
      expect(a2.recovered).toBe("loop/4-wip-lane0-recovered-r4");
      const show = await $`git -C ${a2.dir} show ${a2.recovered}:new-feature.ts`.text();
      expect(show).toBe("unfinished\n");
      const shown = await $`git -C ${a2.dir} show ${a2.recovered}:base.txt`.text();
      expect(shown).toContain("edited by crashed session");
      // And the lane itself is clean on the new branch.
      expect((await $`git -C ${a2.dir} status --porcelain`.text()).trim()).toBe("");
      expect((await $`git -C ${a2.dir} branch --show-current`.text()).trim()).toBe("loop/4-next");
    } finally {
      process.chdir(prevCwd);
    }
  });

  test("includes are re-copied on every acquire and survive the clean", async () => {
    const { primary } = await initRepoWithOrigin();
    const wtRoot = mkdtempSync(join(tmpdir(), "hw-lanes3-"));
    tmp.push(wtRoot);
    const cfg = cfgFor(wtRoot);
    // .env is git-ignored in the primary (the realistic case) and listed in .worktreeinclude.
    await Bun.write(join(primary, ".gitignore"), ".env\n");
    await Bun.write(join(primary, ".env"), "SECRET=1\n");
    await Bun.write(join(primary, ".worktreeinclude"), ".env\n");
    await $`git -C ${primary} add .gitignore .worktreeinclude`.quiet();
    await $`git -C ${primary} commit -q -m ignore`.quiet();
    await $`git -C ${primary} push -q origin main`.quiet();

    const prevCwd = process.cwd();
    process.chdir(primary);
    try {
      const a1 = await acquireLane({
        cfg,
        lane: 0,
        branch: "loop/5-env",
        issueNumber: 5,
        runId: "r5",
        repoRoot: primary,
        log: () => {},
      });
      expect(a1.includes).toEqual([".env"]);
      expect(await readFile(join(a1.dir, ".env"), "utf8")).toBe("SECRET=1\n");

      await releaseLane(cfg, 0);
      await Bun.write(join(primary, ".env"), "SECRET=2\n"); // rotated between issues
      const a2 = await acquireLane({
        cfg,
        lane: 0,
        branch: "loop/6-env2",
        issueNumber: 6,
        runId: "r6",
        repoRoot: primary,
        log: () => {},
      });
      // The copy is fresh every acquire — a stale env from the previous issue never leaks forward.
      expect(await readFile(join(a2.dir, ".env"), "utf8")).toBe("SECRET=2\n");
      // And the ignored .env did NOT trip the dirty-lane salvage (it's ignored, not leftovers).
      expect(a2.recovered).toBeNull();

      // Dropping the pattern removes the copy from the lane — a revoked secret must not linger.
      await releaseLane(cfg, 0);
      await Bun.write(join(primary, ".worktreeinclude"), "# nothing anymore\n");
      const a3 = await acquireLane({
        cfg,
        lane: 0,
        branch: "loop/7-env3",
        issueNumber: 7,
        runId: "r7",
        repoRoot: primary,
        log: () => {},
      });
      expect(a3.includes).toEqual([]);
      expect(await readFile(join(a3.dir, ".env"), "utf8").catch(() => "GONE")).toBe("GONE");
    } finally {
      process.chdir(prevCwd);
    }
  });

  test("committed-but-unpushed work on the SAME branch survives a retry's checkout -B", async () => {
    const { primary } = await initRepoWithOrigin();
    const wtRoot = mkdtempSync(join(tmpdir(), "hw-lanes4-"));
    tmp.push(wtRoot);
    const cfg = cfgFor(wtRoot);

    const prevCwd = process.cwd();
    process.chdir(primary);
    try {
      const a1 = await acquireLane({
        cfg,
        lane: 0,
        branch: "loop/8-retry",
        issueNumber: 8,
        runId: "r8",
        repoRoot: primary,
        log: () => {},
      });
      // Session commits, then the driver dies before push/release: clean tree, branch attached, ahead.
      await Bun.write(join(a1.dir, "done-work.ts"), "committed\n");
      await $`git -C ${a1.dir} add -A`.quiet();
      await $`git -C ${a1.dir} commit -q -m "feat: half done"`.quiet();

      const a2 = await acquireLane({
        cfg,
        lane: 0,
        branch: "loop/8-retry", // the retry reuses the SAME branch name — checkout -B resets it
        issueNumber: 8,
        runId: "r9",
        repoRoot: primary,
        log: () => {},
      });
      expect(a2.recovered).toBe("loop/8-wip-lane0-recovered-r9");
      const shown = await $`git -C ${a2.dir} show ${a2.recovered}:done-work.ts`.text();
      expect(shown).toBe("committed\n");
      // The impl branch itself was reset to base for the fresh attempt.
      expect((await $`git -C ${a2.dir} status --porcelain`.text()).trim()).toBe("");
    } finally {
      process.chdir(prevCwd);
    }
  });

  test("scripts.setup runs with HAMSTER_* context env vars; cold flag flips on reuse", async () => {
    const { primary } = await initRepoWithOrigin();
    const wtRoot = mkdtempSync(join(tmpdir(), "hw-lanes5-"));
    tmp.push(wtRoot);
    // The probe ships in the repo (like a real setup script) and records what hamster exported.
    await Bun.write(
      join(primary, "setup-probe.sh"),
      'printf "cold=%s name=%s path=%s root=%s issue=%s run=%s\\n" ' +
        '"$HAMSTER_LANE_COLD" "$HAMSTER_WORKSPACE_NAME" "$HAMSTER_WORKSPACE_PATH" ' +
        '"$HAMSTER_ROOT_PATH" "$HAMSTER_ISSUE" "$HAMSTER_RUN_ID" > hamster-env.txt\n',
    );
    await $`git -C ${primary} add -A`.quiet();
    await $`git -C ${primary} commit -q -m probe`.quiet();
    await $`git -C ${primary} push -q origin main:main`.quiet();
    const cfg = cfgFor(wtRoot, { scripts: { setup: "sh setup-probe.sh" } });

    const prevCwd = process.cwd();
    process.chdir(primary);
    try {
      const a1 = await acquireLane({
        cfg,
        lane: 0,
        branch: "loop/9-env",
        issueNumber: 9,
        runId: "rE1",
        repoRoot: primary,
        log: () => {},
      });
      expect(await readFile(join(a1.dir, "hamster-env.txt"), "utf8")).toBe(
        `cold=1 name=lane-0 path=${a1.dir} root=${primary} issue=9 run=rE1\n`,
      );

      await releaseLane(cfg, 0);
      const a2 = await acquireLane({
        cfg,
        lane: 0,
        branch: "loop/10-env",
        issueNumber: 10,
        runId: "rE2",
        repoRoot: primary,
        log: () => {},
      });
      // clean -fd removed the previous dump; the warm re-run rewrote it with cold=0.
      expect(await readFile(join(a2.dir, "hamster-env.txt"), "utf8")).toBe(
        `cold=0 name=lane-0 path=${a2.dir} root=${primary} issue=10 run=rE2\n`,
      );

      // skipSetup (the sandbox path) must not run the script at all.
      await releaseLane(cfg, 0);
      const a3 = await acquireLane({
        cfg,
        lane: 0,
        branch: "loop/11-env",
        issueNumber: 11,
        runId: "rE3",
        repoRoot: primary,
        skipSetup: true,
        log: () => {},
      });
      expect(await readFile(join(a3.dir, "hamster-env.txt"), "utf8").catch(() => null)).toBeNull();
    } finally {
      process.chdir(prevCwd);
    }
  });
});
