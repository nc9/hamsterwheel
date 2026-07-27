import type { Config } from "@hamsterwheel/config";
import { formatSessionPlan, resolveSessionPolicy } from "@hamsterwheel/gate";

import { addItem, comment, fetchItemState, listItems, setBlocked, setStatus } from "./board.ts";
import { buildQueue, enrichItem, isEpic, type LoopIssue } from "./issues.ts";
import { type LoopDeps, claimAndRun } from "./pipeline.ts";

/** Shared context for every board-backed command. */
export type CommandDeps = Omit<LoopDeps, "prOnly" | "sandbox" | "bypassPermissions"> & {
  prOnly?: boolean;
  sandbox?: boolean;
  bypassPermissions?: boolean;
};

const fmt = (ns: number[]) => (ns.length ? ns.map((n) => `#${n}`).join(" ") : "none");

const policyOf = (cfg: Config, iss: LoopIssue) =>
  resolveSessionPolicy(iss, { implement: cfg.runners.implement, review: cfg.runners.review });

/** READ-ONLY: the queue, the skip reasons, and the resolved runner/model/effort per issue. No mutations. */
export const plan = async (deps: CommandDeps): Promise<void> => {
  const { gh, cfg, ctx, log } = deps;
  const { eligible, skipped } = await buildQueue(gh, cfg, await listItems(gh, ctx));
  log(`\nEligible queue (priority → size → age):`);
  eligible.forEach((i, n) => {
    const p = policyOf(cfg, i);
    log(
      `  ${n + 1}. #${i.number} [P${i.priority} sz${i.size}] ${i.title.slice(0, 56)}\n` +
        `        implement ${formatSessionPlan(p.implement)} · review ${formatSessionPlan(p.review)}`,
    );
  });
  if (!eligible.length) log("  (none)");
  if (skipped.length) {
    log(`\nSkipped:`);
    for (const s of skipped) log(`  #${s.num}: ${s.why}`);
  }
  log(eligible.length ? `\n→ would pick #${eligible[0]!.number}` : `\n→ queue empty, idle`);
  log(
    `\n  (source key: r=runner m=model e=effort · l=label c=config h=heuristic r=runner-default)`,
  );
};

/** Auto-block passes: missing acceptance criteria, and suspected prompt injection. Mutates the board. */
export const runTriagePasses = async (deps: CommandDeps): Promise<void> => {
  const { gh, cfg, ctx, log } = deps;
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
    }
  }
};

/** PM doctor: what needs human triage. Read-only unless `--sync` (adds missing issues as Draft). */
export const triage = async (deps: CommandDeps, sync: boolean): Promise<void> => {
  const { gh, cfg, ctx, log } = deps;
  const items = await listItems(gh, ctx);
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

  log(`\nTRIAGE — project #${ctx.projectNumber}`);
  log(
    `Board: ${items.length} items — ${internal.length} in ${cfg.repo}, ${items.length - internal.length} elsewhere\n`,
  );
  log(
    `Not on board (open):      ${missing.length ? `${missing.map((m) => `${m.repo}#${m.number}`).join(" ")}${sync ? "  (synced ✓)" : "  [--sync to add]"}` : "none ✓"}`,
  );
  log(
    `Draft · needs priority:   ${fmt(draft.filter((i) => i.priority === 9).map((i) => i.number))}`,
  );
  log(
    `Draft · needs size:       ${fmt(draft.filter((i) => !i.labels.some((l) => l.toLowerCase().startsWith("size:"))).map((i) => i.number))}`,
  );
  log(
    `Ready · needs criteria:   ${fmt(ready.filter((i) => !i.hasCriteria).map((i) => i.number))}  (auto-blocks on run)`,
  );
  log(
    `Ready · injection-flagged:${fmt(ready.filter((i) => i.injection.length).map((i) => i.number))}`,
  );
  log(`Ready · epic (decompose): ${fmt(readyEpics)}`);
  log(`Blocked (awaiting human): ${fmt(byStatus(cfg.board.status.blocked).map((i) => i.number))}`);
  const { eligible } = await buildQueue(gh, cfg, items);
  log(
    `\nReady & eligible: ${eligible.length}${eligible.length ? ` → next #${eligible[0]!.number}` : " (idle)"}`,
  );
};

/** Report items stuck in flight with no live session behind them. Read-only: a human decides. */
export const reconcile = async (deps: CommandDeps): Promise<void> => {
  const { gh, cfg, ctx, log } = deps;
  const inflight = (await listItems(gh, ctx)).filter(
    (i) => i.status === cfg.board.status.inProgress || i.status === cfg.board.status.inReview,
  );
  if (!inflight.length) return log("reconcile: nothing in flight");
  for (const it of inflight)
    log(
      `  in-flight: #${it.content?.number} [${it.status}] — verify a live run owns it (${cfg.board.ownerField} field), else reset to ${cfg.board.status.ready}`,
    );
};

/** `once` / `run`: work the queue. Serial by construction — one issue start→merge→next. */
export const workQueue = async (
  deps: CommandDeps,
  opts: { loop: boolean; execute: boolean; issue?: number },
): Promise<void> => {
  const { gh, cfg, ctx, log } = deps;
  const loopDeps: LoopDeps = { ...deps };

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
    // A run-fatal error would recur identically on every remaining item, so it aborts the run instead of
    // walking the queue and blocking each item in turn. claimAndRun has already released its claim.
    await claimAndRun(loopDeps, next, opts.execute);
  } while (opts.loop);
};
