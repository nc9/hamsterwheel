/**
 * GitHub API quota: the precondition whose exhaustion looks exactly like a broken board.
 *
 * THE INCIDENT THIS EXISTS FOR: a 53-item Ready queue was built (53 board mutations) and `plan` re-run a
 * handful of times. That drained the 5000-point GraphQL budget, and the next `plan` failed at
 * `gh project field-list` — which reads as "the board is misconfigured", not "wait 40 minutes". REST
 * `core` was still at 4998 the whole time, so every `gh issue` / `gh pr` command kept working normally,
 * which makes the wrong diagnosis very easy to reach.
 *
 * Two things make this worth a dedicated check:
 *
 * 1. **The pools are separate.** Projects v2 is GraphQL-only, so board traffic drains `graphql` while
 *    `core` sits untouched. Healthy-looking REST proves nothing about the loop's ability to run.
 * 2. **Reading the quota is FREE.** `gh api rate_limit` does not consume either budget, so this can run
 *    on every tick with no cost — there is no tradeoff to weigh.
 */
import type { Gh } from "./gh.ts";

export type RateWindow = { limit: number; remaining: number; used: number; resetAt: number };
export type RateLimits = { graphql: RateWindow; core: RateWindow };

/**
 * GraphQL cost, front-loaded into startup and dominated by TOTAL BOARD SIZE — not by how many issues are
 * Ready, and not by how much work gets done.
 *
 * MEASURED, not guessed: one `run` startup on a 415-item board with 14 Ready consumed 1251 points
 * (1982 → 731), i.e. ~3.0 per board item. The first version of this model costed only the Ready items and
 * predicted 36, so its floor would have cheerfully started a run with 200 points left that then died
 * during the queue build — the exact failure the check exists to prevent.
 *
 * The reason is `listItems`: it pulls EVERY item on the board with its field values, so a board that has
 * accumulated hundreds of Done items is expensive to read even when the queue is tiny. `enrichItem`'s
 * per-Ready `gh issue view` and `isEpic`'s sub-issue query are the secondary term.
 */
export const PER_BOARD_ITEM_COST = 3;
export const PER_CANDIDATE_COST = 2;
/** Claim, board transitions, the re-read before claiming, PR lookups and the close comment. */
export const PIPELINE_COST = 20;

/** One-time startup cost: read the whole board, then enrich and rank the Ready subset. */
export const estimateQueueBuildCost = (boardItems: number, readyCount: number): number =>
  Math.max(0, boardItems) * PER_BOARD_ITEM_COST + Math.max(0, readyCount) * PER_CANDIDATE_COST;

/** What starting a run needs: read+rank the board, then carry `issues` of them to Done. */
export const estimateRunCost = (boardItems: number, readyCount: number, issues = 1): number =>
  estimateQueueBuildCost(boardItems, readyCount) + Math.max(1, issues) * PIPELINE_COST;

/**
 * Floor for preflight, which runs before either count is known. Calibrated to comfortably cover the
 * measured 415-item board; on a small board this is stricter than necessary, which is the correct
 * direction — it costs a wait, whereas being too low costs a run that dies holding a claim.
 *
 * The pre-claim check inside the run uses PIPELINE_COST instead, because by then the board read and the
 * queue ranking are already paid for and only this issue's own pipeline is still owed.
 */
export const DEFAULT_GRAPHQL_FLOOR = estimateRunCost(450, 50);
/**
 * Headroom below which the operator should know, even though the current call can still proceed. Must sit
 * ABOVE `DEFAULT_GRAPHQL_FLOOR` or the band is unreachable — everything below the floor already fails.
 */
export const GRAPHQL_WARN_AT = 2000;
/** REST `core` funds PR/issue/CI reads. Cheaper per tick than GraphQL, so a lower floor. */
export const CORE_FLOOR = 100;

export type QuotaVerdict = {
  level: "ok" | "warn" | "fail";
  detail: string;
  /** Set when a pool is below its floor — the run-fatal message names it. */
  exhausted?: "graphql" | "core";
};

/** `2314` → `38m`. The operator's actual decision is "wait or debug", so the wait must be legible. */
export const formatReset = (seconds: number): string => {
  if (seconds <= 0) return "now";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.ceil(seconds / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

const describe = (w: RateWindow, nowSeconds: number): string =>
  `${w.remaining}/${w.limit} left, resets in ${formatReset(w.resetAt - nowSeconds)}`;

/**
 * Pure verdict over both pools. `null` limits mean the read FAILED, which is unknown — never reported as
 * healthy, and never fatal either: a broken `gh` is already caught by the auth/binary checks, and
 * refusing to run because a free metadata call failed would be its own outage.
 */
export const quotaVerdict = (
  limits: RateLimits | null,
  opts: { nowSeconds: number; graphqlFloor?: number },
): QuotaVerdict => {
  if (limits === null)
    return {
      level: "warn",
      detail: "could not read `gh api rate_limit` — quota UNKNOWN (not verified healthy)",
    };
  const floor = opts.graphqlFloor ?? DEFAULT_GRAPHQL_FLOOR;
  const { graphql, core } = limits;
  // GraphQL first: it is the pool that wedges the board, and the one whose exhaustion is misread.
  if (graphql.remaining < floor)
    return {
      level: "fail",
      exhausted: "graphql",
      detail:
        `GraphQL quota ${describe(graphql, opts.nowSeconds)} — below the ~${floor} points needed to proceed. ` +
        `REST core is ${core.remaining}/${core.limit}, so \`gh issue\`/\`gh pr\` will still work: this is a quota wall, not a broken board.`,
    };
  if (core.remaining < CORE_FLOOR)
    return {
      level: "fail",
      exhausted: "core",
      detail: `REST core quota ${describe(core, opts.nowSeconds)} — below the ${CORE_FLOOR} points PR and CI reads need.`,
    };
  if (graphql.remaining < GRAPHQL_WARN_AT)
    return {
      level: "warn",
      // Below the startup floor the binding constraint is no longer THIS call — it is that the next run
      // cannot even read the board. Say that, rather than dividing by a floor the caller chose, which
      // produced the misleading "room for 36 more" at 731 points left.
      detail:
        `GraphQL quota ${describe(graphql, opts.nowSeconds)}` +
        (graphql.remaining < DEFAULT_GRAPHQL_FLOOR
          ? ` — enough to finish in-flight work, but below the ~${DEFAULT_GRAPHQL_FLOOR} a fresh run needs just to read the board.`
          : " — getting low."),
    };
  return {
    level: "ok",
    detail: `GraphQL ${describe(graphql, opts.nowSeconds)} · REST core ${core.remaining}/${core.limit}`,
  };
};

type RateWindowResponse = { limit?: number; remaining?: number; used?: number; reset?: number };
type RateLimitResponse = {
  resources?: { graphql?: RateWindowResponse; core?: RateWindowResponse };
};

// `remaining` defaults to 0, not the limit: a malformed payload must read as exhausted, never as healthy.
const toWindow = (w: RateWindowResponse): RateWindow => ({
  limit: w.limit ?? 0,
  remaining: w.remaining ?? 0,
  used: w.used ?? 0,
  resetAt: w.reset ?? 0,
});

/**
 * Read both pools. Free — `rate_limit` is not itself rate-limited — so callers never need to ration it.
 * Returns null on any failure, keeping "unknown" distinguishable from "healthy".
 */
export const fetchRateLimits = async (gh: Gh): Promise<RateLimits | null> => {
  const r = await gh.tryJson<RateLimitResponse>(["api", "rate_limit"]);
  if (!r?.resources?.graphql || !r.resources.core) return null;
  return { graphql: toWindow(r.resources.graphql), core: toWindow(r.resources.core) };
};
