/** Structural mirror of `@hamsterwheel/config`'s HumanRule — gate stays dependency-free. */
export type HumanRule = { name: string; pathsRe?: RegExp; labels?: string[] };

// Work matching a human-review rule is NEVER auto-merged — the canonical example is a DB migration
// (applied to prod by a human; auto-deploying code ahead of the schema breaks prod), but rules also
// cover label-marked domains (security, auth, payments) and sensitive paths. Err toward blocking — a
// false positive just routes the PR to a human. A rule fires on ANY changed file matching `pathsRe`
// OR ANY issue label matching `labels` (case-insensitive). Returns fired rule names in config order.
export const matchHumanRules = (
  rules: HumanRule[],
  files: string[],
  labels: string[],
): string[] => {
  const lower = labels.map((l) => l.toLowerCase());
  return rules
    .filter(
      (rule) =>
        (rule.pathsRe !== undefined && files.some((f) => rule.pathsRe!.test(f))) ||
        (rule.labels ?? []).some((l) => lower.includes(l.toLowerCase())),
    )
    .map((rule) => rule.name);
};

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

/**
 * Did a review actually run against the CURRENT head, or are we reading silence?
 *
 * `blockingReview: 0` is ambiguous: it means "no blocking findings" AND "no review happened" AND "the
 * only review on this PR predates the commit we're about to merge". Absence of a signal is not approval.
 * Observed: GitHub's review action refuses to run on any PR that edits a workflow file (supply-chain
 * protection), skips, and reports the check as SUCCESS — so the highest-risk PRs get a green check, no
 * comment, and, since the gate reads the LAST bot comment regardless of age, a stale review of an
 * earlier commit.
 *
 * `commentAt`/`headAt` are ISO timestamps; a missing `commentAt` means no review comment exists at all.
 */
export const reviewCoversHead = (commentAt: string | undefined, headAt: string): boolean => {
  if (!commentAt) return false;
  const c = Date.parse(commentAt);
  const h = Date.parse(headAt);
  // Unparseable either side → treat as not covered. This is a safety check; garbage in must not read
  // as "reviewed".
  if (Number.isNaN(c) || Number.isNaN(h)) return false;
  return c >= h;
};

export type GateSignals = {
  ciGreen: boolean;
  /** Names of fired `[[human]]` rules (`matchHumanRules`). Any entry parks the PR for a human. */
  humanRules: string[];
  /**
   * `review.mode === "required"`. When false, a missing review is not a blocker — findings that DO
   * exist still are. Passed in rather than read from config so the decision stays a pure function.
   */
  reviewRequired: boolean;
  /** False when no review comment postdates the head commit. Absence of findings is NOT approval. */
  reviewObserved: boolean;
  blockingReview: number;
  /**
   * A reviewer's latest submitted review is CHANGES_REQUESTED — a human explicitly withholding
   * approval, which unlike prose findings carries no severity to weigh. Blocks regardless of whether
   * review is `required` or `optional`. Under `off` it is never fetched, so it can never be set:
   * `off` means the gate does not look at reviews at all (see `ReviewMode`).
   */
  changesRequested: boolean;
  rubricPass: boolean;
};
export type GateAction = { action: "MERGE" } | { action: "BLOCK"; reason: string; detail: string };
// Deterministic merge decision. Order: CI (fundamental) → human rules (safety) → changes-requested →
// review provenance (mode-gated) → review findings → rubric.
export const mergeDecision = (s: GateSignals): GateAction => {
  if (!s.ciGreen) return { action: "BLOCK", reason: "ci-red", detail: "CI not green" };
  if (s.humanRules.length > 0)
    return {
      action: "BLOCK",
      reason: "needs-human",
      detail: `matched human-review rule(s): ${s.humanRules.join(", ")} — a human reviews/applies, then merges`,
    };
  // Ahead of the mode check: a human hitting "Request changes" outranks any configuration saying
  // reviews are optional. GitHub keeps that state until the reviewer re-reviews, so it is not aged out
  // against the head — being stale is exactly what "I asked for changes and nobody came back" means.
  if (s.changesRequested)
    return {
      action: "BLOCK",
      reason: "needs-decision",
      detail: "a reviewer requested changes",
    };
  // Before trusting a clean review, require evidence one happened. Ordered ahead of the findings check
  // so a stale-but-clean comment can never stand in for a review of the code being merged.
  if (s.reviewRequired && !s.reviewObserved)
    return {
      action: "BLOCK",
      reason: "needs-decision",
      detail: "no review of the current head — silence is not approval",
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
