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

/**
 * Delete ONE named branch. Named, never a pattern: a glob sweep (`for-each-ref 'refs/heads/fix/*' |
 * xargs git branch -D`) once deleted ~54 branches instead of the intended 10, including unmerged
 * local-only work from prior months. The `(was <sha>)` line git prints is the only recovery handle
 * that made that survivable, so it is returned and logged rather than swallowed.
 */
export const deleteBranch = async (
  branch: string,
): Promise<{ ok: boolean; was: string; error: string }> => {
  const r = await $`git branch -D ${branch}`.quiet().nothrow();
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
  const r = await $`git -C ${worktree} merge-base ${remote} HEAD`.quiet().nothrow();
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
    const r = await $`git -C ${worktree} diff --name-only ${ref}`.quiet().nothrow();
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
  await $`git -C ${worktree} branch --unset-upstream`.quiet().nothrow();
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
