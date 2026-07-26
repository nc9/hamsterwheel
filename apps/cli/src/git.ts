import { $ } from "bun";

/** Thin git helpers. Every argument is interpolated by Bun Shell as a single quoted token, never a word. */

export const fetchBase = async (baseBranch: string): Promise<void> => {
  // Refresh the base per issue so a later item in a multi-issue run branches off the LATEST merged base,
  // not the ref captured at process start. A transient failure (offline/race) is tolerated.
  await $`git fetch origin ${baseBranch}`.quiet().nothrow();
};

/** Dir-less worktree registrations block `worktree add -B` with "already checked out". */
export const pruneWorktrees = async (): Promise<void> => {
  await $`git worktree prune`.quiet().nothrow();
};

export const addWorktree = async (args: string[]): Promise<void> => {
  const r = await $`git ${args}`.quiet().nothrow();
  if (r.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString().trim().slice(0, 300)}`);
};

export const removeWorktree = async (worktree: string): Promise<void> => {
  await $`git worktree remove --force ${worktree}`.quiet().nothrow();
};

/** Local branch names under a prefix. Prefix match (trailing "/", no glob). */
export const localBranches = async (prefix: string): Promise<string[]> => {
  const out = (
    await $`git for-each-ref --format=${"%(refname:short)"} ${`refs/heads/${prefix}/`}`
      .quiet()
      .nothrow()
  ).stdout.toString();
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
};

export const deleteBranch = async (branch: string): Promise<{ ok: boolean; error: string }> => {
  const r = await $`git branch -D ${branch}`.quiet().nothrow();
  return { ok: r.exitCode === 0, error: r.stderr.toString().trim().slice(0, 200) };
};

/**
 * Run the configured install command in a fresh worktree (raw `worktree add` skips any session hooks).
 * Split on whitespace and spawned WITHOUT a shell — no pipes, `&&` or globbing. A command needing those
 * belongs in a script the config points at.
 */
export const runInstall = async (cmd: string, cwd: string): Promise<void> => {
  const parts = cmd.split(/\s+/).filter(Boolean);
  if (!parts.length) return;
  const proc = Bun.spawn(parts, { cwd, stdout: "ignore", stderr: "pipe" });
  await proc.exited;
  if (proc.exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`install_cmd "${cmd}" failed in ${cwd}: ${err.trim().slice(0, 300)}`);
  }
};
