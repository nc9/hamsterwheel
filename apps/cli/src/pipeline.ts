import type { Config } from "@hamsterwheel/config";
import {
  type GateAction,
  type RubricVerdict,
  applyCiToRubric,
  buildImplementPrompt,
  buildRubricPrompt,
  classifyImplement,
  detectMigration,
  mergeDecision,
  parseRubricVerdict,
  preserveWorktreeChanges,
  resolveSessionPolicy,
  reviewBlockingFindings,
  wipBranchName,
  worktreeAddArgs,
  worktreeHasChanges,
} from "@hamsterwheel/gate";
import { RUNNER_CAPABILITIES, contractLine } from "@hamsterwheel/runners";

import { type BoardCtx, clearOwner, comment, setBlocked, setOwner, setStatus } from "./board.ts";
import type { Gh } from "./gh.ts";
import { addWorktree, fetchBase, pruneWorktrees, removeWorktree, runInstall } from "./git.ts";
import { type LoopIssue, branchName, findPriorClosingPr } from "./issues.ts";
import { type Clock, type RunLog, makeRunId } from "./runlog.ts";
import { runSession } from "./session.ts";

/** Everything the per-issue pipeline needs. Passed as one object so the call sites stay readable. */
export type LoopDeps = {
  gh: Gh;
  cfg: Config;
  ctx: BoardCtx;
  log: (msg: string) => void;
  runLog: RunLog;
  now?: Clock;
  /** Stop after the PR is open (skip gate + merge) — for supervised runs. */
  prOnly?: boolean;
  sandbox?: boolean;
  bypassPermissions?: boolean;
};

// The rubric verdict shape, as a JSON Schema — handed to runners that can pin their final response
// (codex `--output-schema`). parseRubricVerdict stays the fallback for runners without schema support,
// and still parses the schema-pinned output unchanged (same keys).
const RUBRIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pass", "criteria"],
  properties: {
    pass: { type: "boolean" },
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "met"],
        properties: {
          text: { type: "string" },
          met: { type: "boolean" },
          evidence: { type: "string" },
        },
      },
    },
  },
};

const checkName = (c: { name?: string; context?: string }): string => c.name ?? c.context ?? "?";

/** Poll PR checks until every non-skipped check completes (or the configured timeout). */
export const waitForChecks = async (
  gh: Gh,
  cfg: Config,
  prNum: number,
  sleep: (ms: number) => Promise<void> = Bun.sleep,
  now: () => number = Date.now,
): Promise<{ green: boolean; failing: string[]; passing: string[] }> => {
  const deadline = now() + cfg.ciTimeoutMs;
  for (;;) {
    const r = (await gh.tryJson<{
      statusCheckRollup: {
        name?: string;
        context?: string;
        status?: string;
        conclusion?: string;
      }[];
    }>(["pr", "view", String(prNum), "-R", cfg.repo, "--json", "statusCheckRollup"])) ?? {
      statusCheckRollup: [],
    };
    const rel = (r.statusCheckRollup ?? []).filter((c) => c.conclusion !== "SKIPPED");
    const pending = rel.filter((c) => c.status !== "COMPLETED");
    if (rel.length && !pending.length) {
      const failing = rel.filter((c) => c.conclusion !== "SUCCESS").map(checkName);
      const passing = rel.filter((c) => c.conclusion === "SUCCESS").map(checkName);
      return { green: failing.length === 0, failing, passing };
    }
    // A timeout is NOT green: an unfinished CI run has proved nothing. A repo with NO checks at all also
    // lands here (nothing ever completes), which parks the PR as ci-red — deliberate: a loop that merges
    // without a deterministic gate has no gate.
    if (now() > deadline)
      return { green: false, failing: ["<timeout waiting for CI>"], passing: [] };
    await sleep(30_000);
  }
};

export const prTouchesMigration = async (gh: Gh, cfg: Config, prNum: number): Promise<boolean> => {
  const files = (await gh.text(["pr", "diff", String(prNum), "-R", cfg.repo, "--name-only"]))
    .split("\n")
    .filter(Boolean);
  return detectMigration(files, cfg.migrationPathRe);
};

/**
 * Blocking findings from the configured review bot. Both surfaces are read: an issue-level comment
 * (what most review bots post) AND submitted PR reviews, so a bot that switches format doesn't silently
 * drop findings.
 */
export const fetchBlockingReview = async (
  gh: Gh,
  cfg: Config,
  prNum: number,
): Promise<string[]> => {
  const jq = `[.[]|select(.user.login=="${cfg.review.bot}")]|last|.body // ""`;
  const issueComments =
    (await gh.tryText(["api", `repos/${cfg.repo}/issues/${prNum}/comments`, "--jq", jq])) ?? "";
  const prReviews =
    (await gh.tryText(["api", `repos/${cfg.repo}/pulls/${prNum}/reviews`, "--jq", jq])) ?? "";
  return reviewBlockingFindings(`${issueComments}\n${prReviews}`, cfg.review.blockingSeverityRe);
};

/**
 * Fresh ADVERSARIAL grader (read-only, did not write the code) scoring each criterion against the
 * RESULTING codebase in the PR worktree. `applyCiToRubric` is the deterministic backstop that credits
 * execution-dependent criteria once CI is green — the prompt paragraph saying so is only advisory.
 */
export const runRubric = async (
  deps: LoopDeps,
  iss: LoopIssue,
  prNum: number,
  worktree: string,
  ci: { green: boolean; passing: string[] },
): Promise<RubricVerdict> => {
  const { gh, cfg } = deps;
  const plan = resolveSessionPolicy(iss, {
    implement: cfg.runners.implement,
    review: cfg.runners.review,
  }).review;
  const diff = await gh.text(["pr", "diff", String(prNum), "-R", cfg.repo]);
  const prompt = buildRubricPrompt({
    issueNumber: iss.number,
    issueBody: iss.body,
    prNumber: prNum,
    diff,
    ci,
    baseBranch: cfg.baseBranch,
    loopName: "hamsterwheel loop",
    criteriaHeading: cfg.criteriaHeading,
    diffLimit: cfg.maxDiffBytes,
  });

  let schemaPath: string | undefined;
  if (RUNNER_CAPABILITIES[plan.runner].supportsOutputSchema) {
    schemaPath = `${worktree}/.hamsterwheel-rubric.schema.json`;
    await Bun.write(schemaPath, JSON.stringify(RUBRIC_SCHEMA));
  }
  const out = await runSession({
    plan,
    role: "review",
    prompt,
    cwd: worktree,
    timeoutMs: deps.cfg.sessionTimeoutMs,
    outputSchemaPath: schemaPath,
    sandbox: deps.sandbox,
    log: deps.log,
  });
  if (schemaPath)
    await Bun.file(schemaPath)
      .delete()
      .catch(() => {});
  if (out.timedOut) throw new Error("rubric session timed out");
  deps.runLog.append("rubric-session", {
    issue: iss.number,
    runner: plan.runner,
    model: plan.model,
  });
  return applyCiToRubric(parseRubricVerdict(out.lastMessage || out.raw), ci.green);
};

/** Gather the gate signals, skipping the rubric session when an earlier gate already blocks. */
export const runMergeGate = async (
  deps: LoopDeps,
  iss: LoopIssue,
  prNum: number,
  worktree: string,
): Promise<GateAction> => {
  const { cfg, gh, log } = deps;
  log(`  gate #${iss.number} PR #${prNum}: waiting for CI…`);
  const ci = await waitForChecks(gh, cfg, prNum);
  const hasMigration = await prTouchesMigration(gh, cfg, prNum);
  const blocking = await fetchBlockingReview(gh, cfg, prNum);
  let rubricPass = false;
  if (ci.green && !hasMigration && !blocking.length) {
    log("  gate: CI green, no migration, review clean → running rubric…");
    rubricPass = (await runRubric(deps, iss, prNum, worktree, ci)).pass;
  }
  const decision = mergeDecision({
    ciGreen: ci.green,
    hasMigration,
    blockingReview: blocking.length,
    rubricPass,
  });
  deps.runLog.append("gate", {
    issue: iss.number,
    pr: prNum,
    ciGreen: ci.green,
    failing: ci.failing,
    hasMigration,
    blockingReview: blocking.length,
    rubricPass,
    decision,
  });
  return decision;
};

type ImplementSuccess =
  | { kind: "pr"; url: string }
  | { kind: "resolved"; via: "agent-signal" }
  | { kind: "maybe-resolved" };

/** Run the implement session in a fresh worktree. Throws on a real failure; the caller salvages. */
export const runImplement = async (
  deps: LoopDeps,
  iss: LoopIssue,
  branch: string,
  worktree: string,
): Promise<ImplementSuccess> => {
  const { cfg, log } = deps;
  // Last-line defense: never spawn on injection-flagged content even if the queue filter was bypassed.
  if (iss.injection.length)
    throw new Error(`refusing to run: injection markers (${iss.injection.join(", ")})`);

  await fetchBase(cfg.baseBranch);
  await pruneWorktrees();
  await addWorktree(worktreeAddArgs(worktree, branch, `origin/${cfg.baseBranch}`));

  const plan = resolveSessionPolicy(iss, {
    implement: cfg.runners.implement,
    review: cfg.runners.review,
  }).implement;
  const prompt = buildImplementPrompt({
    issueNumber: iss.number,
    issueTitle: iss.title,
    issueBody: iss.body,
    repoSlug: cfg.repo,
    branch,
    baseBranch: cfg.baseBranch,
    loopName: "hamsterwheel loop",
    criteriaHeading: cfg.criteriaHeading,
  });

  if (!deps.sandbox) {
    // A fresh worktree has no dependencies — install so the session can typecheck and test. The sandbox
    // path installs inside the container instead (Linux-native modules over the mounted worktree) — note
    // the image entrypoint hardcodes `bun install` there, so config's install_cmd applies to this path only.
    log(`  installing deps in worktree (${cfg.installCmd}) …`);
    await runInstall(cfg.installCmd, worktree);
  }
  log(
    `  spawning implement session (${plan.runner}${plan.model ? `/${plan.model}` : ""}${plan.effort ? `/${plan.effort}` : ""}) in ${worktree} …`,
  );
  if (deps.bypassPermissions && !deps.sandbox)
    log(
      "  ⚠ bypassPermissions grants the session unrestricted tools. Worktree-scoped and env-scrubbed, but NOT OS-isolated (use --sandbox).",
    );
  deps.runLog.append("implement-session", {
    issue: iss.number,
    branch,
    runner: plan.runner,
    model: plan.model,
    effort: plan.effort,
    sandbox: Boolean(deps.sandbox),
  });

  const out = await runSession({
    plan,
    role: "implement",
    prompt,
    cwd: worktree,
    timeoutMs: cfg.sessionTimeoutMs,
    allowedTools: cfg.allowedTools,
    bypassPermissions: deps.bypassPermissions,
    sandbox: deps.sandbox,
    log,
  });
  if (out.timedOut)
    throw new Error(
      `implement session exceeded the ${Math.round(cfg.sessionTimeoutMs / 60000)}m timeout — killed`,
    );

  const outcome = classifyImplement({
    lastLine: contractLine(out),
    exitCode: out.exitCode,
    hasChanges: await worktreeHasChanges(worktree, `origin/${cfg.baseBranch}`),
  });
  if (outcome.kind === "fail")
    throw new Error(
      `implement session returned no PR url and left changes (or exited non-zero) — a real failure:\nstdout: ${out.raw.slice(-400)}\nstderr: ${out.stderr.slice(-400)}`,
    );
  return outcome;
};

/**
 * One issue, claim → merge/Blocked. The invariants here are the expensive ones:
 *  - the claim is guarded on the Owner field, and a partial claim is fully rolled back (status AND owner);
 *  - a failed session's dirty worktree is salvaged to a run-scoped WIP branch BEFORE teardown;
 *  - once the branch is pushed, salvage is skipped (the remote is the durable copy);
 *  - the worktree is always removed, success or failure.
 */
export const claimAndRun = async (
  deps: LoopDeps,
  iss: LoopIssue,
  execute: boolean,
): Promise<void> => {
  const { cfg, ctx, gh, log } = deps;
  const now = deps.now ?? (() => new Date());
  const runId = makeRunId(iss.number, now);
  const branch = branchName(cfg, iss);
  const worktree = `${cfg.worktreeRoot}/${runId}`;

  if (!execute) {
    log(
      `\n▷ would claim #${iss.number} — ${iss.title}  [no --execute → no board mutation; branch ${branch}]`,
    );
    return;
  }

  // Claim guard: a non-empty Owner means another run already holds this item. This is a read-then-write,
  // NOT an atomic compare-and-set (Projects v2 has no conditional field update) — serial execution is what
  // actually makes double-claims impossible; this only stops a second driver or a leftover claim being stomped.
  if (iss.owner?.trim()) {
    log(`  ⤳ #${iss.number} already claimed by run ${iss.owner.trim()} — skipping`);
    return;
  }

  log(`\n▶ claiming #${iss.number} — ${iss.title}`);
  try {
    await setStatus(gh, ctx, iss.itemId, cfg.board.status.inProgress);
    await setOwner(gh, ctx, iss.itemId, runId);
    await comment(
      gh,
      cfg.repo,
      iss.number,
      `🐹 **hamsterwheel** claimed this issue.\n- run: \`${runId}\`\n- branch: \`${branch}\`\n- started: ${now().toISOString()}`,
    );
    deps.runLog.append("claim", { issue: iss.number, branch, worktree });
  } catch (e) {
    // Roll the claim back so the item isn't orphaned In Progress with no live session behind it. The
    // OWNER must be cleared too: a half-claim (owner written, comment failed) would leave the item Ready
    // with a live-looking owner, and the claim guard above would then skip it forever.
    await setStatus(gh, ctx, iss.itemId, cfg.board.status.ready).catch(() => {});
    await clearOwner(gh, ctx, iss.itemId).catch(() => {});
    log(
      `  ✗ claim failed for #${iss.number}, rolled back to ${cfg.board.status.ready}: ${String(e).slice(0, 160)}`,
    );
    return;
  }

  // Once a PR is open the branch is pushed, so any later failure has its work safe on the remote — a
  // local WIP ref would be a misleading duplicate.
  let workPushed = false;
  try {
    const outcome = await runImplement(deps, iss, branch, worktree);
    if (outcome.kind !== "pr") {
      // No diff: the work is already in the base branch (a stale board entry) — Done, not Blocked. A bare
      // empty session with no explicit signal is only a CANDIDATE; corroborate with a prior merged PR,
      // else it could be a silent give-up, so block for a human.
      const prior = await findPriorClosingPr(gh, cfg, iss.number);
      if (outcome.kind === "maybe-resolved" && !prior) {
        await setBlocked(gh, ctx, cfg, iss.itemId, cfg.board.blockedReasons.needsDecision);
        await comment(
          gh,
          cfg.repo,
          iss.number,
          "🐹 The implement session produced no diff, and no merged PR that closes this issue could be found — can't confirm it is already resolved (this is indistinguishable from a silent no-op). Blocked for human review.",
        );
        log(
          `  ⏸ #${iss.number} → Blocked: ${cfg.board.blockedReasons.needsDecision} (empty session, no corroborating PR)`,
        );
        deps.runLog.append("blocked", {
          issue: iss.number,
          reason: "empty-session-uncorroborated",
        });
        return;
      }
      const why =
        outcome.kind === "resolved"
          ? "the implement agent reported no code changes were needed"
          : `the implement session produced no diff against \`${cfg.baseBranch}\``;
      await setStatus(gh, ctx, iss.itemId, cfg.board.status.done);
      await comment(
        gh,
        cfg.repo,
        iss.number,
        `🐹 **Already resolved** — ${why}; the change is already in \`${cfg.baseBranch}\`, so no PR was opened.${prior ? ` A prior merged PR resolved it: ${prior.url}.` : ""} Marked Done.`,
      );
      log(`  ✓ #${iss.number} → Done (already resolved${prior ? `, prior PR ${prior.url}` : ""})`);
      deps.runLog.append("done", { issue: iss.number, via: outcome.kind, priorPr: prior?.number });
      return;
    }

    const prMatch = outcome.url.match(/\/pull\/(\d+)/);
    if (!prMatch)
      throw new Error(`could not parse a PR number from the implement output: ${outcome.url}`);
    const prNum = Number(prMatch[1]); // validated — a NaN here would hang waitForChecks for the full timeout
    workPushed = true;
    await setStatus(gh, ctx, iss.itemId, cfg.board.status.inReview);
    log(`  ✓ #${iss.number} → ${cfg.board.status.inReview} (${outcome.url})`);
    deps.runLog.append("pr-open", { issue: iss.number, pr: prNum, url: outcome.url });

    if (deps.prOnly) {
      await comment(
        gh,
        cfg.repo,
        iss.number,
        `🐹 PR opened: ${outcome.url}\n\n\`--pr-only\`: stopping here for human review — merge gate and auto-merge skipped.`,
      );
      log(`  ⏸ #${iss.number} stopped at the PR (--pr-only) — ${outcome.url}`);
      return;
    }

    await comment(
      gh,
      cfg.repo,
      iss.number,
      `🐹 PR opened: ${outcome.url} — running the merge gate (CI · migration · review · rubric).`,
    );
    const decision = await runMergeGate(deps, iss, prNum, worktree);
    if (decision.action === "MERGE") {
      // Tolerate the local-branch-delete error (the branch is checked out in the worktree) iff the PR
      // actually merged.
      await gh
        .text(["pr", "merge", String(prNum), "-R", cfg.repo, "--squash", "--delete-branch"])
        .catch(async (e) => {
          const state = (
            (await gh.tryText([
              "pr",
              "view",
              String(prNum),
              "-R",
              cfg.repo,
              "--json",
              "state",
              "-q",
              ".state",
            ])) ?? ""
          ).trim();
          if (state !== "MERGED") throw e;
        });
      await setStatus(gh, ctx, iss.itemId, cfg.board.status.done);
      await comment(
        gh,
        cfg.repo,
        iss.number,
        `🐹 **Merged** ${outcome.url} — CI green · no migration · review clean · rubric passed.`,
      );
      log(`  ✓ #${iss.number} → Done (merged ${outcome.url})`);
      deps.runLog.append("merged", { issue: iss.number, pr: prNum });
    } else {
      await setBlocked(gh, ctx, cfg, iss.itemId, decision.reason);
      await comment(
        gh,
        cfg.repo,
        iss.number,
        `🐹 Held at the merge gate → **Blocked: ${decision.reason}** — ${decision.detail}. PR: ${outcome.url}.`,
      );
      log(`  ⏸ #${iss.number} → Blocked: ${decision.reason} (${decision.detail})`);
      deps.runLog.append("blocked", {
        issue: iss.number,
        reason: decision.reason,
        detail: decision.detail,
      });
    }
  } catch (e) {
    // Salvage any LOCAL-ONLY work the failed session left BEFORE the finally removes the worktree — a
    // fail-with-dirty-tree exit (or committed-but-never-pushed work) would otherwise be discarded,
    // forcing a retry to re-spend the whole session.
    const wip = workPushed
      ? null
      : await preserveWorktreeChanges(
          worktree,
          wipBranchName(iss.number, runId, cfg.branchPrefix),
          `origin/${cfg.baseBranch}`,
        ).catch(() => null);
    await setBlocked(gh, ctx, cfg, iss.itemId, cfg.board.blockedReasons.needsDecision).catch(
      () => {},
    );
    const wipLine = wip
      ? `\n\n💾 The failed session's uncommitted/unpushed work was preserved on local branch \`${wip}\` (it survives worktree cleanup — point a retry at it or inspect before discarding).`
      : "";
    await comment(
      gh,
      cfg.repo,
      iss.number,
      `🐹 Implement/gate step failed → **Blocked: ${cfg.board.blockedReasons.needsDecision}**.${wipLine}\n\n\`\`\`\n${String(e).slice(0, 800)}\n\`\`\``,
    ).catch(() => {});
    log(
      `  ✗ #${iss.number} failed → Blocked: ${String(e).slice(0, 160)}${wip ? ` (WIP preserved on ${wip})` : ""}`,
    );
    deps.runLog.append("failed", {
      issue: iss.number,
      error: String(e).slice(0, 800),
      wipBranch: wip,
    });
  } finally {
    // Always remove the worktree so stale dirs don't accumulate. Dirty work was already salvaged onto a
    // plain ref, which outlives the worktree.
    await removeWorktree(worktree);
  }
};
