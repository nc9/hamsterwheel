// A PR that adds/changes a DB migration is NEVER auto-merged — prod migrations are applied by a human
// (surgical SQL), and auto-deploying code ahead of the schema would break prod. Err toward blocking — a
// false positive just routes the PR to a human. `pathRe` is REQUIRED: it matches the repo's migration
// directory. Example: a drizzle project whose migrations live under apps/api/drizzle/ (incl.
// drizzle/pg-migrations/) would pass /(^|\/)drizzle\//i.
export const detectMigration = (files: string[], pathRe: RegExp): boolean =>
  files.some((f) => pathRe.test(f));

// Scan an auto-review body for BLOCKING findings. Nits/low/medium don't block; high/critical do (the
// loop won't merge over them — a human triages). Errs toward blocking (false positive = human looks).
// `blockingRe` is overridable so a different review format can supply its own severity pattern.
export const BLOCKING_REVIEW_RE =
  /\(\s*(high|critical)\s*\)|🔴|\[(critical|high)\]|severity:\s*(high|critical)/i;
export const reviewBlockingFindings = (
  body: string,
  blockingRe: RegExp = BLOCKING_REVIEW_RE,
): string[] =>
  body
    .split("\n")
    .filter((l) => blockingRe.test(l))
    .map((l) => l.trim().slice(0, 140));

export type GateSignals = {
  ciGreen: boolean;
  hasMigration: boolean;
  blockingReview: number;
  rubricPass: boolean;
};
export type GateAction = { action: "MERGE" } | { action: "BLOCK"; reason: string; detail: string };
// Deterministic merge decision. Order: CI (fundamental) → migration (safety) → review (safety) → rubric.
export const mergeDecision = (s: GateSignals): GateAction => {
  if (!s.ciGreen) return { action: "BLOCK", reason: "ci-red", detail: "CI not green" };
  if (s.hasMigration)
    return {
      action: "BLOCK",
      reason: "needs-prod-migration",
      detail: "PR adds a DB migration — apply to prod manually, then merge",
    };
  if (s.blockingReview > 0)
    return {
      action: "BLOCK",
      reason: "needs-decision",
      detail: `${s.blockingReview} blocking review finding(s)`,
    };
  if (!s.rubricPass)
    return { action: "BLOCK", reason: "rubric-fail", detail: "acceptance criteria not all met" };
  return { action: "MERGE" };
};
