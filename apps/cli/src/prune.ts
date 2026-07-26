import type { Config } from "@hamsterwheel/config";
import { type PruneDecision, classifyWipBranch, parseWipBranches } from "@hamsterwheel/gate";

import type { Gh } from "./gh.ts";
import { deleteBranch, localBranches } from "./git.ts";

/**
 * Sweep stale local WIP salvage branches (`<prefix>/<n>-wip-<runid>`). These are LOCAL-ONLY by
 * construction and nothing else ever deletes them. Needs no board — it runs standalone.
 *
 * Conservative by construction: a branch is deleted ONLY on "issue affirmatively closed AND confirmed
 * not the head of an open PR". A failed lookup is not a passed safety check.
 */

const issueStateOf = async (
  gh: Gh,
  repo: string,
  num: number,
): Promise<"open" | "closed" | "unknown"> => {
  const raw = await gh.tryText([
    "issue",
    "view",
    String(num),
    "-R",
    repo,
    "--json",
    "state",
    "-q",
    ".state",
  ]);
  if (raw === null) return "unknown";
  const s = raw.trim();
  return s === "OPEN" ? "open" : s === "CLOSED" ? "closed" : "unknown";
};

/**
 * Defense-in-depth: WIP branches are local-only, but a human could have pushed one to recover work and
 * opened a PR from it. The query string is built by hand (not -f/-F) because `gh api` silently switches
 * those flags' request to POST, which on this endpoint would try to CREATE a PR.
 */
const openPrForBranch = async (
  gh: Gh,
  cfg: Config,
  branch: string,
): Promise<"open" | "none" | "unknown"> => {
  const head = encodeURIComponent(`${cfg.owner}:${branch}`);
  const r = await gh.tryJson<{ number: number }[]>([
    "api",
    `repos/${cfg.repo}/pulls?head=${head}&state=open`,
  ]);
  if (r === null) return "unknown";
  return r.length > 0 ? "open" : "none";
};

export const planPrune = async (gh: Gh, cfg: Config): Promise<PruneDecision[]> => {
  const branches = parseWipBranches(await localBranches(cfg.branchPrefix), cfg.branchPrefix);
  const states = new Map<number, "open" | "closed" | "unknown">();
  const decisions: PruneDecision[] = [];
  for (const b of branches) {
    let state = states.get(b.issueNumber);
    if (!state) {
      state = await issueStateOf(gh, cfg.repo, b.issueNumber);
      states.set(b.issueNumber, state);
    }
    const prState = state === "closed" ? await openPrForBranch(gh, cfg, b.branch) : "none";
    decisions.push(classifyWipBranch(b, state, prState));
  }
  return decisions;
};

export const runPrune = async (
  gh: Gh,
  cfg: Config,
  opts: { delete: boolean; log: (m: string) => void },
): Promise<void> => {
  const decisions = await planPrune(gh, cfg);
  if (!decisions.length)
    return opts.log(`prune: no local ${cfg.branchPrefix}/*-wip-* branches found`);
  const toPrune = decisions.filter((d) => d.action === "prune");
  opts.log(
    `\nprune plan (${decisions.length} local WIP branch${decisions.length === 1 ? "" : "es"}):`,
  );
  for (const d of decisions)
    opts.log(`  ${d.action === "prune" ? "✂ prune" : "· keep "}  ${d.branch}  — ${d.reason}`);
  opts.log(`\n${toPrune.length} prunable, ${decisions.length - toPrune.length} kept.`);
  if (!opts.delete) {
    if (toPrune.length)
      opts.log("\n(dry run — pass --delete to actually remove these local branches)");
    return;
  }
  // One explicit branch at a time, from a classified list — never a pattern handed to xargs. The
  // `(was <sha>)` git prints is logged because it is the only handle that makes a wrong delete
  // recoverable. Note when auditing such a sha: a squash-merged branch tip is NOT an ancestor of the
  // base branch, so `merge-base --is-ancestor` reports false loss.
  for (const d of toPrune) {
    const r = await deleteBranch(d.branch);
    opts.log(
      r.ok
        ? `  deleted ${d.branch}${r.was ? ` (was ${r.was} — restore with \`git branch ${d.branch} ${r.was}\`)` : ""}`
        : `  ✗ failed to delete ${d.branch}: ${r.error}`,
    );
  }
};
