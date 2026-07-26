import { $ } from "bun";

// -B not -b: a re-run reuses the branch name (remove frees the dir, leaves the ref) and -b dies exit-255
// on it. baseRef is the REMOTE base (default origin/main) so re-runs branch off the latest merged base.
export const worktreeAddArgs = (
  worktree: string,
  branch: string,
  baseRef = "origin/main",
): string[] => ["worktree", "add", worktree, "-B", branch, baseRef];

// Run-scoped WIP branch a failed session's work is salvaged onto. The runId (not the reused
// <prefix>/<n>-<slug> impl branch, which a retry's `-B` resets) is what makes it durable.
export const wipBranchName = (issueNumber: number, runId: string, prefix = "loop"): string =>
  `${prefix}/${issueNumber}-wip-${runId}`;

// True if the worktree diverges from the base ref at all — committed OR uncommitted (tracked) changes,
// or any untracked file. False = the session left the base untouched (already-resolved, not a failure).
// baseRef (refreshed pre-session, default origin/main) is the base; the worktree's local `main` is stale.
export async function worktreeHasChanges(
  worktree: string,
  baseRef = "origin/main",
): Promise<boolean> {
  const diff = await $`git -C ${worktree} diff --quiet ${baseRef}`.quiet().nothrow();
  const status = await $`git -C ${worktree} status --porcelain`.quiet().nothrow();
  return diff.exitCode !== 0 || status.stdout.toString().trim().length > 0;
}

// Salvage whatever a FAILED implement/gate session left in the worktree onto a durable local branch
// BEFORE the worktree is removed, so a retry (or a human) can recover it instead of re-spending the whole
// session (full feature done, died on final formatting → worktree removed → work gone). Folds the dirty
// tree (tracked edits + untracked files) into a salvage commit, then points the run-scoped branch at HEAD
// so any session commits are captured too. Returns the branch name if work was preserved, else null
// (clean tree / no worktree — nothing to save). Best-effort, non-throwing: the caller is already failing.
export async function preserveWorktreeChanges(
  worktree: string,
  wipBranch: string,
  baseRef = "origin/main",
): Promise<string | null> {
  // Worktree may not exist if the failure predates `git worktree add` (e.g. a missing --sandbox token).
  const inside = await $`git -C ${worktree} rev-parse --is-inside-work-tree`.quiet().nothrow();
  if (inside.exitCode !== 0) return null;
  if (!(await worktreeHasChanges(worktree, baseRef))) return null; // clean no-op → nothing to preserve
  await $`git -C ${worktree} add -A`.quiet().nothrow();
  // Only commit if something is actually staged. A no-op commit ("nothing to commit") exits non-zero
  // harmlessly — but a REAL commit failure (e.g. missing git identity) must NOT fall through to branching
  // at the pre-salvage HEAD and falsely report the uncommitted work as preserved. So gate on the staged
  // check, and if there IS staged content the commit must succeed. --no-verify: hooks false-fail in fresh worktrees.
  const staged = await $`git -C ${worktree} diff --cached --quiet`.quiet().nothrow(); // exit != 0 ⇒ staged content exists
  if (staged.exitCode !== 0) {
    const committed =
      await $`git -C ${worktree} commit --no-verify -m ${`wip: preserve failed loop session (${wipBranch})`}`
        .quiet()
        .nothrow();
    if (committed.exitCode !== 0) return null; // couldn't capture the staged work → don't claim a false save
  }
  // Final guarantee against a false "preserved": if ANY uncommitted change remains (e.g. `add -A` itself
  // failed partway on a bad gitlink/permission), the salvage did NOT capture the tree — don't claim a save.
  const leftover = await $`git -C ${worktree} status --porcelain`.quiet().nothrow();
  if (leftover.stdout.toString().trim().length > 0) return null;
  const r = await $`git -C ${worktree} branch -f ${wipBranch} HEAD`.quiet().nothrow();
  return r.exitCode === 0 ? wipBranch : null;
}

// ---- prune: sweep stale local WIP salvage branches ----
//
// preserveWorktreeChanges branches (loop/<issue>-wip-<runid>) are LOCAL-ONLY — created via
// `git -C <worktree> branch -f`, never pushed (once the branch is pushed the remote is the durable copy;
// a local WIP ref would just be a misleading duplicate). They accumulate forever since nothing else
// deletes them. This sweep only ever reads/deletes LOCAL refs.

// Matches ONLY the WIP salvage branch shape, not the reused <prefix>/<n>-<slug> impl branch (no "-wip-"
// segment) — the pattern anchor is what keeps prune from ever touching an unrelated <prefix>/* branch.
export const WIP_BRANCH_RE = /^loop\/(\d+)-wip-(.+)$/;
/** The same anchored shape for a configured branch prefix. The prefix is escaped: it is config, not a pattern. */
export const wipBranchRe = (prefix = "loop"): RegExp =>
  new RegExp(`^${prefix.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(\\d+)-wip-(.+)$`);

export type WipBranchInfo = { branch: string; issueNumber: number; runId: string };

export const parseWipBranches = (names: string[], prefix = "loop"): WipBranchInfo[] => {
  const re = wipBranchRe(prefix);
  return names.flatMap((branch) => {
    const m = re.exec(branch);
    return m ? [{ branch, issueNumber: Number(m[1]), runId: m[2]! }] : [];
  });
};

export type PruneAction = "prune" | "keep";
export type PruneDecision = WipBranchInfo & { action: PruneAction; reason: string };

// Conservative by construction: anything short of "issue affirmatively closed AND confirmed not the head
// of an open PR" keeps the ref — never drop a salvage that could be the only copy of unrecovered work.
// prState "unknown" (the open-PR lookup itself failed — network/auth/rate limit) must keep, same as
// issueState "unknown" — a failed safety check is not a passed one.
export const classifyWipBranch = (
  info: WipBranchInfo,
  issueState: "open" | "closed" | "unknown",
  prState: "open" | "none" | "unknown",
): PruneDecision => {
  if (issueState === "unknown")
    return {
      ...info,
      action: "keep",
      reason: "issue state lookup failed — keeping conservatively",
    };
  if (issueState === "open")
    return { ...info, action: "keep", reason: `issue #${info.issueNumber} still open` };
  if (prState === "open")
    return { ...info, action: "keep", reason: "branch is the head of an open PR" };
  if (prState === "unknown")
    return { ...info, action: "keep", reason: "open-PR lookup failed — keeping conservatively" };
  return { ...info, action: "prune", reason: `issue #${info.issueNumber} closed` };
};
