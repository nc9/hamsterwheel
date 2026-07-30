import type { Config } from "@hamsterwheel/config";
import {
  type SessionPlan,
  formatSessionPlan,
  matchHumanRules,
  resolveSessionPolicy,
} from "@hamsterwheel/gate";

import {
  type BoardItem,
  addItem,
  comment,
  fetchItemState,
  listItems,
  setBlocked,
  setStatus,
} from "./board.ts";
import { RunFatalError } from "./errors.ts";
import type { Gh } from "./gh.ts";
import { buildQueue, enrichItem, isEpic, type LoopIssue, type QueueSkip } from "./issues.ts";
import { type LoopDeps, claimAndRun } from "./pipeline.ts";
import { PIPELINE_COST, fetchRateLimits, quotaVerdict } from "./quota.ts";

/**
 * Every read-style command returns a structured report and renders it separately, so `--json` emits the
 * same data the human output is printed from — never a second, drifting code path.
 */

/** Shared context for every board-backed command. */
export type CommandDeps = Omit<LoopDeps, "prOnly" | "sandbox" | "bypassPermissions"> & {
  prOnly?: boolean;
  sandbox?: boolean;
  bypassPermissions?: boolean;
};

const fmt = (ns: number[]) => (ns.length ? ns.map((n) => `#${n}`).join(" ") : "none");

const policyOf = (cfg: Config, iss: LoopIssue) =>
  resolveSessionPolicy(iss, { implement: cfg.runners.implement, review: cfg.runners.review });

/** Open issues across the source repos that are not on the board. Deliberate design: the board being
 * opt-in is the trust gate (nothing runs un-curated), so drift must be VISIBLE, not auto-fixed. */
export const listOffBoardIssues = async (
  gh: Gh,
  cfg: Config,
  items: BoardItem[],
): Promise<{ repo: string; number: number; url: string }[]> => {
  const onBoard = new Set(
    items
      .filter((i) => i.content?.number)
      .map((i) => `${i.content!.repository}#${i.content!.number}`),
  );
  const missing: { repo: string; number: number; url: string }[] = [];
  for (const repo of cfg.sourceRepos) {
    const open = await gh.json<{ number: number; url: string }[]>([
      "issue",
      "list",
      "-R",
      repo,
      "--state",
      "open",
      "--limit",
      "500",
      "--json",
      "number,url",
    ]);
    for (const o of open) if (!onBoard.has(`${repo}#${o.number}`)) missing.push({ repo, ...o });
  }
  return missing;
};

export type PlanReport = {
  eligible: {
    number: number;
    title: string;
    priority: number;
    size: number;
    implement: SessionPlan;
    review: SessionPlan;
    /** `[[human]]` rules already fired by the issue's labels — the PR will park as needs-human.
     * Path rules can only be evaluated at gate time, so this is a lower bound. */
    humanRules: string[];
  }[];
  skipped: QueueSkip[];
  /** Issue number the loop would pick next, or null when the queue is empty. */
  pick: number | null;
  /** Open issues across the source repos that aren't on the board — visible drift, never auto-fixed. */
  offBoard: number;
};

/** READ-ONLY: the queue, the skip reasons, and the resolved runner/model/effort per issue. No mutations. */
export const plan = async (deps: CommandDeps): Promise<PlanReport> => {
  const { gh, cfg, ctx } = deps;
  const items = await listItems(gh, ctx);
  const { eligible, skipped } = await buildQueue(gh, cfg, items);
  const offBoard = (await listOffBoardIssues(gh, cfg, items)).length;
  return {
    offBoard,
    eligible: eligible.map((i) => {
      const p = policyOf(cfg, i);
      return {
        number: i.number,
        title: i.title,
        priority: i.priority,
        size: i.size,
        implement: p.implement,
        review: p.review,
        humanRules: matchHumanRules(cfg.humanRules, [], i.labels),
      };
    }),
    skipped,
    pick: eligible[0]?.number ?? null,
  };
};

export const renderPlan = (r: PlanReport, log: (m: string) => void): void => {
  log(`\nEligible queue (priority → size → age):`);
  r.eligible.forEach((i, n) => {
    log(
      `  ${n + 1}. #${i.number} [P${i.priority} sz${i.size}] ${i.title.slice(0, 56)}\n` +
        `        implement ${formatSessionPlan(i.implement)} · review ${formatSessionPlan(i.review)}` +
        (i.humanRules.length ? `\n        ⏸ will park for human (${i.humanRules.join(", ")})` : ""),
    );
  });
  if (!r.eligible.length) log("  (none)");
  if (r.skipped.length) {
    log(`\nSkipped:`);
    for (const s of r.skipped) log(`  #${s.num}: ${s.why}`);
  }
  if (r.offBoard)
    log(
      `\n· ${r.offBoard} open issue${r.offBoard === 1 ? " is" : "s are"} not on the board — \`hamster triage --sync\` folds them in as Draft`,
    );
  log(r.pick !== null ? `\n→ would pick #${r.pick}` : `\n→ queue empty, idle`);
  log(
    `\n  (source key: r=runner m=model e=effort · l=label c=config h=heuristic r=runner-default)`,
  );
};

export type AutoBlockAction = {
  issue: number;
  reason: "injection" | "no-criteria";
  markers?: string[];
};

/** Auto-block passes: missing acceptance criteria, and suspected prompt injection. Mutates the board. */
export const runTriagePasses = async (deps: CommandDeps): Promise<AutoBlockAction[]> => {
  const { gh, cfg, ctx, log } = deps;
  const actions: AutoBlockAction[] = [];
  const ready = (await listItems(gh, ctx)).filter((i) => i.status === cfg.board.status.ready);
  for (const item of ready) {
    const iss = await enrichItem(gh, cfg, item);
    if (!iss) continue;
    // Injection first: a flagged issue must never be spawned, whatever else is wrong with it.
    if (iss.injection.length) {
      await setBlocked(gh, ctx, cfg, item.id, cfg.board.blockedReasons.needsDecision);
      await comment(
        gh,
        cfg.repo,
        iss.number,
        `🐹 This issue's text tripped a prompt-injection tripwire (\`${iss.injection.join("`, `")}\`) and will **not** be auto-worked. Blocked for human review — if the content is legitimate, reword it or run the issue manually.`,
      );
      log(
        `#${iss.number}: Blocked → ${cfg.board.blockedReasons.needsDecision} (injection: ${iss.injection.join(", ")})`,
      );
      deps.runLog.append("triage-block", {
        issue: iss.number,
        reason: "injection",
        markers: iss.injection,
      });
      actions.push({ issue: iss.number, reason: "injection", markers: iss.injection });
      continue;
    }
    if (!iss.hasCriteria) {
      await setBlocked(gh, ctx, cfg, item.id, cfg.board.blockedReasons.needsCriteria);
      await comment(
        gh,
        cfg.repo,
        iss.number,
        `🐹 Marked \`${cfg.board.status.ready}\` without a \`## ${cfg.criteriaHeading}\` checklist. Blocked — add the checklist (it becomes the merge rubric) and flip back to ${cfg.board.status.ready}.`,
      );
      log(`#${iss.number}: Blocked → ${cfg.board.blockedReasons.needsCriteria}`);
      deps.runLog.append("triage-block", { issue: iss.number, reason: "no-criteria" });
      actions.push({ issue: iss.number, reason: "no-criteria" });
    }
  }
  return actions;
};

export type TriageReport = {
  board: { total: number; internal: number };
  missing: { repo: string; number: number; url: string }[];
  /** Whether --sync folded the missing issues onto the board. */
  synced: boolean;
  draftNeedsPriority: number[];
  draftNeedsSize: number[];
  readyNeedsCriteria: number[];
  readyInjectionFlagged: number[];
  readyEpics: number[];
  blocked: number[];
  eligible: number;
  next: number | null;
};

/** PM doctor: what needs human triage. Read-only unless `sync` (adds missing issues as Draft). */
export const triage = async (deps: CommandDeps, sync: boolean): Promise<TriageReport> => {
  const { gh, cfg, ctx, log } = deps;
  const items = await listItems(gh, ctx);
  const missing = await listOffBoardIssues(gh, cfg, items);
  if (sync)
    for (const m of missing) {
      const id = await addItem(gh, ctx, m.url);
      await setStatus(gh, ctx, id, cfg.board.status.draft);
      log(`  +board ${m.repo}#${m.number} (${cfg.board.status.draft})`);
    }

  const internal = items.filter((i) => i.content?.repository === cfg.repo);
  const enriched = (await Promise.all(internal.map((i) => enrichItem(gh, cfg, i)))).filter(
    (i): i is LoopIssue => i !== null,
  );
  const statusById = new Map(items.map((i) => [i.id, i.status ?? "(none)"]));
  const byStatus = (s: string) => enriched.filter((i) => statusById.get(i.itemId) === s);

  const draft = byStatus(cfg.board.status.draft);
  const ready = byStatus(cfg.board.status.ready);
  const readyEpics: number[] = [];
  for (const i of ready) if (await isEpic(gh, cfg, i.number, i.title)) readyEpics.push(i.number);

  const { eligible } = await buildQueue(gh, cfg, items);
  return {
    board: { total: items.length, internal: internal.length },
    missing,
    synced: sync,
    draftNeedsPriority: draft.filter((i) => i.priority === 9).map((i) => i.number),
    draftNeedsSize: draft
      .filter((i) => !i.labels.some((l) => l.toLowerCase().startsWith("size:")))
      .map((i) => i.number),
    readyNeedsCriteria: ready.filter((i) => !i.hasCriteria).map((i) => i.number),
    readyInjectionFlagged: ready.filter((i) => i.injection.length).map((i) => i.number),
    readyEpics,
    blocked: byStatus(cfg.board.status.blocked).map((i) => i.number),
    eligible: eligible.length,
    next: eligible[0]?.number ?? null,
  };
};

export const renderTriage = (
  r: TriageReport,
  projectNumber: number,
  cfgRepo: string,
  log: (m: string) => void,
): void => {
  log(`\nTRIAGE — project #${projectNumber}`);
  log(
    `Board: ${r.board.total} items — ${r.board.internal} in ${cfgRepo}, ${r.board.total - r.board.internal} elsewhere\n`,
  );
  log(
    `Not on board (open):      ${r.missing.length ? `${r.missing.map((m) => `${m.repo}#${m.number}`).join(" ")}${r.synced ? "  (synced ✓)" : "  [--sync to add]"}` : "none ✓"}`,
  );
  log(`Draft · needs priority:   ${fmt(r.draftNeedsPriority)}`);
  log(`Draft · needs size:       ${fmt(r.draftNeedsSize)}`);
  log(`Ready · needs criteria:   ${fmt(r.readyNeedsCriteria)}  (auto-blocks on run)`);
  log(`Ready · injection-flagged:${fmt(r.readyInjectionFlagged)}`);
  log(`Ready · epic (decompose): ${fmt(r.readyEpics)}`);
  log(`Blocked (awaiting human): ${fmt(r.blocked)}`);
  log(`\nReady & eligible: ${r.eligible}${r.next !== null ? ` → next #${r.next}` : " (idle)"}`);
};

export type ReconcileReport = {
  inflight: { number: number | null; status: string; owner: string | null }[];
};

/** Report items stuck in flight with no live session behind them. Read-only: a human decides. */
export const reconcile = async (deps: CommandDeps): Promise<ReconcileReport> => {
  const { gh, cfg, ctx } = deps;
  const inflight = (await listItems(gh, ctx)).filter(
    (i) => i.status === cfg.board.status.inProgress || i.status === cfg.board.status.inReview,
  );
  return {
    inflight: inflight.map((i) => ({
      number: i.content?.number ?? null,
      status: i.status ?? "(none)",
      owner:
        typeof i.fields[cfg.board.ownerField.toLowerCase()] === "string"
          ? (i.fields[cfg.board.ownerField.toLowerCase()] as string)
          : null,
    })),
  };
};

export const renderReconcile = (
  r: ReconcileReport,
  cfg: Config,
  log: (m: string) => void,
): void => {
  if (!r.inflight.length) return log("reconcile: nothing in flight");
  for (const it of r.inflight)
    log(
      `  in-flight: #${it.number} [${it.status}] — verify a live run owns it (${cfg.board.ownerField} field${it.owner ? `: ${it.owner}` : ""}), else reset to ${cfg.board.status.ready}`,
    );
};

/** `once` / `run`: work the queue. Serial by construction — one issue start→merge→next. */
export const workQueue = async (
  deps: CommandDeps,
  opts: { loop: boolean; execute: boolean; issue?: number },
): Promise<void> => {
  const { gh, cfg, ctx, log } = deps;
  const loopDeps: LoopDeps = { ...deps };

  // The config key ships ahead of wave mode so repos can prepare; only the pool size is inert.
  if (cfg.worktreeLanes > 1)
    log(
      `  (worktree_lanes = ${cfg.worktreeLanes}: parallel lanes are not implemented yet — running serially on lane-0)`,
    );

  if (opts.issue !== undefined) {
    const { eligible } = await buildQueue(gh, cfg, await listItems(gh, ctx));
    const target = eligible.find((i) => i.number === opts.issue);
    if (!target)
      return log(
        `#${opts.issue} is not Ready+eligible — run \`plan\` to see the queue and skip reasons`,
      );
    await claimAndRun(loopDeps, target, opts.execute);
    return;
  }

  // An issue the tick declined to work (already claimed, rolled back to Ready) stays at the head of the
  // queue, so without this the loop would re-pick it every tick until max_iterations. One attempt per
  // issue per invocation.
  const attempted = new Set<number>();
  let iter = 0;
  // Built ONCE. Re-listing per tick pulls every item on the board plus a `gh issue view` for each Ready
  // one; on a 385-item board that exhausted the 5,000-point GraphQL budget after two claims and aborted
  // a serial run on `API rate limit exceeded`. Freshness is preserved where it matters by re-reading the
  // single item about to be claimed, below — O(1) instead of O(board) per tick.
  const { eligible } = await buildQueue(gh, cfg, await listItems(gh, ctx));
  do {
    // Backstop: never loop forever (e.g. an item that always rolls back to Ready).
    if (++iter > cfg.maxIterations) {
      log(`⚠ hit max_iterations (${cfg.maxIterations}) — stopping`);
      break;
    }
    const next = eligible.find((i) => !attempted.has(i.number));
    if (!next) {
      log("queue empty — idle");
      break;
    }
    attempted.add(next.number);
    // The snapshot can be minutes old by now, so confirm THIS item is still Ready and unclaimed before
    // spending a session on it. Unreadable → skip: a failed check is not a passed check.
    const live = await fetchItemState(gh, ctx, next.itemId);
    if (!live) {
      log(
        `  ⤳ #${next.number} — could not re-read board state, skipping rather than claiming blind`,
      );
      continue;
    }
    if (live.status !== cfg.board.status.ready) {
      log(
        `  ⤳ #${next.number} moved to ${live.status ?? "(no status)"} since the queue was built — skipping`,
      );
      continue;
    }
    if (live.owner?.trim()) {
      log(
        `  ⤳ #${next.number} claimed by run ${live.owner.trim()} since the queue was built — skipping`,
      );
      continue;
    }
    next.owner = live.owner;
    // Last free thing before the claim: is there enough GraphQL budget left to carry this issue to Done?
    // Running out MID-pipeline is the expensive shape — the item sits In Progress with a claim and maybe
    // an open PR, and the next run has to reconcile it. Checking here costs nothing (`rate_limit` is not
    // itself rate-limited) and turns that into a clean stop with the queue intact.
    if (opts.execute) {
      const q = quotaVerdict(await fetchRateLimits(gh), {
        nowSeconds: Math.floor(Date.now() / 1000),
        // The queue is already built and paid for, so only this issue's own pipeline is still owed.
        graphqlFloor: PIPELINE_COST,
      });
      if (q.exhausted)
        throw new RunFatalError(
          `api-quota (${q.exhausted}) — stopping before claiming #${next.number}: ${q.detail}`,
          "nothing was claimed; relaunch after the reset and the queue picks up where it left off",
        );
      if (q.level === "warn") log(`  ! quota: ${q.detail}`);
    }
    // A run-fatal error would recur identically on every remaining item, so it aborts the run instead of
    // walking the queue and blocking each item in turn. claimAndRun has already released its claim.
    await claimAndRun(loopDeps, next, opts.execute);
  } while (opts.loop);
};
