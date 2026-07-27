import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Config } from "@hamsterwheel/config";
import {
  preserveWorktreeChanges,
  wipBranchName,
  worktreeAddArgs,
  worktreeHasChanges,
} from "@hamsterwheel/gate";

import {
  addWorktree,
  aheadCount,
  checkoutBranch,
  cleanUntracked,
  currentBranch,
  detachHead,
  fetchBase,
  forceBranchAt,
  gitDirOf,
  isWorktree,
  pruneWorktrees,
  resetHard,
  runSetup,
  unsetUpstream,
} from "./git.ts";

/**
 * Lanes: a fixed pool of PERSISTENT worktrees (lane-0…lane-N-1) reused across issues instead of a
 * throwaway worktree per run. The worktree itself was never the cost — the cold dependency install and the
 * missing git-ignored env files were. A lane keeps node_modules/caches warm (clean is `-fd`, never
 * `-x`) and re-copies `.worktreeinclude` files every acquire.
 *
 * The one invariant that must hold across every acquire/release: NOTHING in a lane is ever discarded
 * without being salvaged onto a durable branch first. `reset --hard` + `clean -fd` destroy work; they
 * run only after a dirty lane's contents are captured, and a failed capture refuses the reset.
 */

export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

/** Lane directory. worktreeRoot is global (~/.hamsterwheel/worktrees), so scope by repo slug. */
export const laneDir = (cfg: Config, lane: number): string =>
  join(cfg.worktreeRoot, cfg.repo.replace("/", "-"), `lane-${lane}`);

/** `.worktreeinclude` lines → patterns. Gitignore-style: blank lines and `#` comments are skipped. */
export const parseWorktreeInclude = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

const escapeRe = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/**
 * One gitignore-style pattern → a RegExp over repo-relative paths ("/"-separated).
 * Subset supported: `*` (within a segment), `**` (across segments), `?` (one char). A pattern with no
 * `/` matches at any depth (like gitignore); a pattern containing `/` is anchored to the repo root.
 * A trailing `/` means "everything under this directory".
 */
export const globToRegExp = (pattern: string): RegExp => {
  let p = pattern.replace(/^\//, "");
  if (p.endsWith("/")) p += "**";
  const rooted = p.includes("/");
  // Placeholders so the rewrites can't cannibalize each other. `**/` matches ZERO or more
  // directories (gitignore semantics) - `**/.env` must match a root-level `.env` - so it becomes an
  // optional group, not a mandatory `.*/`.
  const body = escapeRe(p)
    .replaceAll("**/", "\x00")
    .replaceAll("**", "\x01")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]")
    .replaceAll("\x00", "(?:.*/)?")
    .replaceAll("\x01", ".*");
  return new RegExp(`${rooted ? "^" : "(^|.*/)"}${body}$`);
};

const SKIP_DIRS = new Set([".git", "node_modules"]);

/** Repo-relative paths of files under `root` matching any pattern. Walk skips .git/node_modules. */
export const listIncludeFiles = async (root: string, patterns: string[]): Promise<string[]> => {
  if (!patterns.length) return [];
  const res = patterns.map(globToRegExp);
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(p);
      } else if (e.isFile() && res.some((re) => re.test(p))) out.push(p);
    }
  };
  await walk("");
  return out.sort();
};

/**
 * Copy the primary checkout's `.worktreeinclude` matches into the lane, preserving relative paths.
 * COPY, not symlink — a session must not be able to corrupt the real env files. Returns what landed.
 * No `.worktreeinclude` → no-op (the repo hasn't opted in).
 *
 * A manifest of what the previous acquire copied lives in the lane's PRIVATE git dir (it survives
 * `clean -fd`, which spares ignored files, and dies with the worktree). Files dropped from
 * `.worktreeinclude` are deleted from the lane — a rotated or revoked secret must not linger in a
 * persistent lane a later session can read.
 */
export const copyIncludes = async (repoRoot: string, lane: string): Promise<string[]> => {
  const text = await readFile(join(repoRoot, WORKTREE_INCLUDE_FILE), "utf8").catch(() => null);
  const files = text === null ? [] : await listIncludeFiles(repoRoot, parseWorktreeInclude(text));

  const gitdir = await gitDirOf(lane);
  const manifest = gitdir ? join(gitdir, "hamsterwheel-includes.json") : null;
  if (manifest) {
    const prevRaw = await readFile(manifest, "utf8").catch(() => null);
    const prev: string[] = prevRaw ? (JSON.parse(prevRaw) as string[]) : [];
    for (const stale of prev.filter((f) => !files.includes(f)))
      await rm(join(lane, stale), { force: true });
  }

  for (const f of files) {
    await mkdir(dirname(join(lane, f)), { recursive: true });
    await copyFile(join(repoRoot, f), join(lane, f));
  }
  if (manifest) await writeFile(manifest, JSON.stringify(files));
  return files;
};

/** Env-style files sessions typically need but git ignores — the worktree-readiness heuristic. */
export const ENV_FILE_PATTERNS = [".env", ".env.*", ".dev.vars", ".envrc"];

/** Env-ish files NOT covered by the repo's `.worktreeinclude` patterns — each is invisible to lanes. */
export const uncoveredEnvFiles = (envFiles: string[], patterns: string[]): string[] => {
  const res = patterns.map(globToRegExp);
  return envFiles.filter((f) => !res.some((re) => re.test(f)));
};

export type LaneAcquisition = {
  dir: string;
  /** True when the lane worktree was created cold on this acquire. */
  created: boolean;
  /** WIP branch a crashed run's leftovers were salvaged onto, or null when the lane was clean. */
  recovered: string | null;
  /** Files copied in from `.worktreeinclude`. */
  includes: string[];
};

/**
 * Ready a lane for an issue: salvage any leftovers → reset + clean → branch off the fresh base →
 * drop the inherited upstream → copy includes → (incremental) install.
 */
export const acquireLane = async (opts: {
  cfg: Config;
  lane: number;
  branch: string;
  issueNumber: number;
  runId: string;
  /** Primary checkout root — the source of `.worktreeinclude` files. */
  repoRoot: string;
  /** Sandbox installs in-container; the host-side setup script is skipped there. */
  skipSetup?: boolean;
  log: (m: string) => void;
}): Promise<LaneAcquisition> => {
  const { cfg, branch, log } = opts;
  const dir = laneDir(cfg, opts.lane);
  const baseRef = `origin/${cfg.baseBranch}`;
  await fetchBase(cfg.baseBranch);

  let created = false;
  let recovered: string | null = null;
  if (!(await isWorktree(dir))) {
    await pruneWorktrees(); // dir-less registrations block `worktree add -B`
    await addWorktree(worktreeAddArgs(dir, branch, baseRef));
    created = true;
  } else {
    const wip = wipBranchName(
      opts.issueNumber,
      `lane${opts.lane}-recovered-${opts.runId}`,
      cfg.branchPrefix,
    );
    // Dirty vs the lane's OWN HEAD, not the base: a released lane sits detached at an old base, and a
    // freshly-fetched base would make staleness read as "changes". Only real leftovers count.
    if (await worktreeHasChanges(dir, "HEAD")) {
      recovered = await preserveWorktreeChanges(dir, wip, "HEAD");
      // A dirty lane whose salvage failed is unrecoverable work about to be destroyed — refuse.
      if (!recovered)
        throw new Error(
          `lane ${dir} has uncommitted leftovers and salvage failed — refusing to reset; recover it by hand`,
        );
      log(`  ♻ lane-${opts.lane}: leftover work salvaged to ${recovered}`);
    } else if ((await currentBranch(dir)) === branch && (await aheadCount(dir, baseRef)) > 0) {
      // A crashed run can leave the lane ATTACHED to this same branch with committed-but-unpushed
      // work and a clean tree. `checkout -B` below resets the branch ref — park the commits on the
      // run-scoped WIP branch first. (A different leftover branch keeps its commits on its own ref.)
      await forceBranchAt(dir, wip);
      recovered = wip;
      log(`  ♻ lane-${opts.lane}: unpushed commits on ${branch} preserved on ${wip}`);
    }
    await resetHard(dir);
    await cleanUntracked(dir);
    await checkoutBranch(dir, branch, baseRef);
  }
  // Same direct-to-main mechanism as worktree add: `checkout -B <br> origin/<base>` inherits an
  // upstream, and with push.default=upstream an unpinned push then writes the BASE branch.
  await unsetUpstream(dir);

  const includes = await copyIncludes(opts.repoRoot, dir);
  if (includes.length)
    log(`  ⇢ lane-${opts.lane}: copied ${includes.length} .worktreeinclude file(s)`);

  // One setup script for cold AND warm acquires (a Codex-style separate maintenance script can be
  // added later): package-manager installs are naturally incremental, and a script that cares can
  // branch on HAMSTER_LANE_COLD.
  const setup = cfg.scripts.setup;
  if (setup && !opts.skipSetup) {
    log(`  ⚙ lane-${opts.lane}: scripts.setup (${setup}) — ${created ? "cold" : "warm"} …`);
    await runSetup(setup, dir, {
      HAMSTER_WORKSPACE_PATH: dir,
      HAMSTER_WORKSPACE_NAME: `lane-${opts.lane}`,
      HAMSTER_ROOT_PATH: opts.repoRoot,
      HAMSTER_LANE_COLD: created ? "1" : "0",
      HAMSTER_ISSUE: String(opts.issueNumber),
      HAMSTER_RUN_ID: opts.runId,
    });
  }
  return { dir, created, recovered, includes };
};

/**
 * Detach the lane from the issue branch so the ref is free (deletable, checkable-out elsewhere) and
 * leave the dir in place for the next acquire. Best-effort: a dirty tree can make the detach fail,
 * and the next acquire's salvage-first path handles whatever is left.
 */
export const releaseLane = async (cfg: Config, lane: number): Promise<void> => {
  const dir = laneDir(cfg, lane);
  if (!(await isWorktree(dir))) return;
  await detachHead(dir, `origin/${cfg.baseBranch}`).catch(() => {});
};
