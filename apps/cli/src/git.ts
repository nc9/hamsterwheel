import { git, run } from "@hamsterwheel/runners";

/** Thin git helpers. Every argument is a separate argv element — no shell, so nothing is re-parsed. */

export const fetchBase = async (baseBranch: string): Promise<void> => {
  // Refresh the base per issue so a later item in a multi-issue run branches off the LATEST merged base,
  // not the ref captured at process start. A transient failure (offline/race) is tolerated.
  await git(["fetch", "origin", baseBranch]);
};

/** Dir-less worktree registrations block `worktree add -B` with "already checked out". */
export const pruneWorktrees = async (): Promise<void> => {
  await git(["worktree", "prune"]);
};

export const addWorktree = async (args: string[]): Promise<void> => {
  const r = await git(args);
  if (r.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString().trim().slice(0, 300)}`);
};

export const removeWorktree = async (worktree: string): Promise<void> => {
  await git(["worktree", "remove", "--force", worktree]);
};

/** True when `dir` exists and is inside a git work tree (same probe salvage uses). */
export const isWorktree = async (dir: string): Promise<boolean> =>
  (await git(["rev-parse", "--is-inside-work-tree"], dir)).exitCode === 0;

const must = async (args: string[], cwd: string): Promise<void> => {
  const r = await git(args, cwd);
  if (r.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString().trim().slice(0, 300)}`);
};

/** Discard tracked changes. Callers MUST have salvaged first — this is destructive by design. */
export const resetHard = (worktree: string): Promise<void> => must(["reset", "--hard"], worktree);

/** Remove untracked non-ignored files/dirs (`-fd`, NOT `-x`: ignored files — node_modules, caches,
 * copied env files — are the whole point of a persistent lane). Salvage first: -fd deletes work. */
export const cleanUntracked = (worktree: string): Promise<void> => must(["clean", "-fd"], worktree);

/** `checkout -B` (reset-or-create) — a lane re-run reuses the branch name, same rationale as
 * `worktreeAddArgs`. Only safe because releaseLane detaches, so no other worktree holds the branch. */
export const checkoutBranch = (worktree: string, branch: string, baseRef: string): Promise<void> =>
  must(["checkout", "-B", branch, baseRef], worktree);

/** Detach the lane from its branch so the ref is free for other worktrees / branch deletion. */
export const detachHead = (worktree: string, baseRef: string): Promise<void> =>
  must(["checkout", "--detach", baseRef], worktree);

/** Currently checked-out branch name, or "" when detached. */
export const currentBranch = async (worktree: string): Promise<string> =>
  (await git(["branch", "--show-current"], worktree)).stdout.toString().trim();

/** Commits on HEAD that baseRef doesn't have. 0 on error (an unknown ref proves nothing is ahead). */
export const aheadCount = async (worktree: string, baseRef: string): Promise<number> => {
  const r = await git(["rev-list", "--count", `${baseRef}..HEAD`], worktree);
  return r.exitCode === 0 ? Number(r.stdout.toString().trim()) || 0 : 0;
};

/** Point (or create) a branch at HEAD without switching to it. */
export const forceBranchAt = (worktree: string, name: string): Promise<void> =>
  must(["branch", "-f", name, "HEAD"], worktree);

/** Absolute path of the worktree's PRIVATE git dir (survives `clean -fd`, dies with the worktree). */
export const gitDirOf = async (worktree: string): Promise<string | null> => {
  const r = await git(["rev-parse", "--absolute-git-dir"], worktree);
  const out = r.stdout.toString().trim();
  return r.exitCode === 0 && out ? out : null;
};

/** Toplevel of the repo containing `cwd` — the primary checkout root when run from a subdirectory. */
export const gitToplevel = async (cwd?: string): Promise<string | null> => {
  const r = await git(["rev-parse", "--show-toplevel"], cwd);
  const out = r.stdout.toString().trim();
  return r.exitCode === 0 && out ? out : null;
};

/** Local branch names under a prefix. Prefix match (trailing "/", no glob). */
export const localBranches = async (prefix: string): Promise<string[]> => {
  const out = (await git(["for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}/`]))
    .stdout;
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
};

/**
 * Delete ONE named branch. Named, never a pattern: a glob sweep (`for-each-ref 'refs/heads/fix/*' |
 * xargs git branch -D`) once deleted ~54 branches instead of the intended 10, including unmerged
 * local-only work from prior months. The `(was <sha>)` line git prints is the only recovery handle
 * that made that survivable, so it is returned and logged rather than swallowed.
 */
export const deleteBranch = async (
  branch: string,
): Promise<{ ok: boolean; was: string; error: string }> => {
  const r = await git(["branch", "-D", branch]);
  const was = /\(was ([0-9a-f]+)\)/.exec(r.stdout.toString())?.[1] ?? "";
  return { ok: r.exitCode === 0, was, error: r.stderr.toString().trim().slice(0, 200) };
};

/**
 * The branch's TRUE base: `merge-base origin/<base> HEAD`, not `origin/<base>` itself.
 *
 * Linked worktrees share one object store AND one set of refs, so any peer lane (or the primary) running
 * `git fetch` advances the shared `refs/remotes/origin/<base>` past this branch's base. Diffing against
 * the moved ref then shows OTHER lanes' merged work, reversed, as if this branch had deleted it — a real
 * review once raised HIGH-severity "guard was removed" findings for files the branch never touched.
 * Falls back to the remote ref only if merge-base fails (shallow clone, missing ref).
 */
export const baseRefFor = async (worktree: string, baseBranch: string): Promise<string> => {
  const remote = `origin/${baseBranch}`;
  const r = await git(["merge-base", remote, "HEAD"], worktree);
  const sha = r.stdout.toString().trim();
  return r.exitCode === 0 && sha ? sha : remote;
};

/**
 * Files that appear in a diff against the moving remote ref but NOT in the diff against the true base —
 * i.e. other lanes' work that a stale-base review would misread as this branch's regressions. Empty is
 * the healthy answer; anything else is worth logging loudly before a grader sees the diff.
 */
export const staleBaseFiles = async (
  worktree: string,
  baseBranch: string,
  base: string,
): Promise<string[]> => {
  const names = async (ref: string): Promise<Set<string>> => {
    const r = await git(["diff", "--name-only", ref], worktree);
    return new Set(
      r.stdout
        .toString()
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
  };
  const [againstRemote, againstBase] = await Promise.all([
    names(`origin/${baseBranch}`),
    names(base),
  ]);
  return [...againstRemote].filter((f) => !againstBase.has(f));
};

/**
 * Drop the upstream a fresh worktree inherits. `git worktree add -B <br> origin/<base>` sets upstream to
 * `origin/<base>`, and with `push.default=upstream` a bare `git push -u origin <br>` then resolves its
 * DESTINATION from that upstream and writes refs/heads/<base> — direct-to-main. That exact mechanism
 * produced seven accidental pushes to main in the source repo, and `-u` does not prevent it (it applies
 * after refspec resolution). With no upstream, an unpinned push fails loudly instead of landing on main.
 */
export const unsetUpstream = async (worktree: string): Promise<void> => {
  await git(["branch", "--unset-upstream"], worktree);
};

/**
 * Run the `scripts.setup` command in a lane (raw `worktree add` skips any session hooks).
 * Split on whitespace and spawned WITHOUT a shell — no pipes, `&&` or globbing. A command needing those
 * belongs in a script the config points at. `env` is layered over the process env (HAMSTER_* context).
 */
export const runSetup = async (
  cmd: string,
  cwd: string,
  env: Record<string, string> = {},
): Promise<void> => {
  const parts = cmd.split(/\s+/).filter(Boolean);
  if (!parts.length) return;
  const [bin, ...rest] = parts;
  const r = await run(bin!, rest, { cwd, env: { ...process.env, ...env } });
  if (r.exitCode !== 0)
    throw new Error(`scripts.setup "${cmd}" failed in ${cwd}: ${r.stderr.trim().slice(0, 300)}`);
};
