import {
  type RunnerName,
  type RunnerRole,
  isRunnerName,
  validateEffort,
  validateModel,
} from "@hamsterwheel/runners";

import { SIZE_RANK, type SelectableIssue } from "./select.ts";

/**
 * Per-issue routing of the two headless sessions (implement + review) across four independent axes:
 * runner, model and effort — resolved separately for each role.
 *
 * Resolution order per axis: validated label → config default → built-in heuristic.
 *
 * LOAD-BEARING INVARIANT: GitHub labels are repo-controlled UNTRUSTED text that ends up in a subprocess
 * spawn. Every label-derived value is allow-listed/regex-validated here, and anything invalid (typo,
 * empty, hostile) SILENTLY falls back to the next source — it must never reach the spawn, where it would
 * exit non-zero and read as a generic implement failure. `plan` prints the resolved struct so the
 * effective choice (and where it came from) is visible before a run.
 */

/** Label namespace. `loop:model-*` is the pre-four-axis alias, kept working as `loop:impl-model-*`. */
export const LABEL_PREFIXES = {
  implement: {
    runner: "loop:impl-runner-",
    model: "loop:impl-model-",
    effort: "loop:impl-effort-",
  },
  review: {
    runner: "loop:review-runner-",
    model: "loop:review-model-",
    effort: "loop:review-effort-",
  },
  legacyModel: "loop:model-",
} as const;

export type PolicySource = "label" | "config" | "heuristic" | "runner-default";
export type SessionPlan = {
  runner: RunnerName;
  model?: string;
  effort?: string;
  source: { runner: PolicySource; model: PolicySource; effort: PolicySource };
};
export type ResolvedPolicy = Record<RunnerRole, SessionPlan>;

/** Config-supplied defaults for one role. `strong*`/`cheap*` feed the heuristic tier. */
export type RoleDefaults = {
  runner: RunnerName;
  model?: string;
  /**
   * FLAT effort for every issue on this role. A single value here disables the tier heuristic, which
   * is almost never what an operator means: a run configured `effort = "high"` spent high on XS
   * one-file changes and 4-file rule additions alike, and high effort on mechanical work is the single
   * largest source of wall-clock in a serial loop. Prefer `strongEffort`/`cheapEffort`.
   */
  effort?: string;
  strongModel?: string;
  cheapModel?: string;
  /** Effort for `sessionTier() === "strong"` work — P0/P1 or size M+. */
  strongEffort?: string;
  /** Effort for `sessionTier() === "cheap"` work — XS, or S docs/test/chore/style/ci. */
  cheapEffort?: string;
};
export type PolicyDefaults = Record<RunnerRole, RoleDefaults>;

/**
 * Heuristic tier by task complexity. Small mechanical work runs on the cheap model — cheaper AND lighter
 * on the shared session quota (a wave dies at ~10 big-model sessions), so a mixed wave stretches further.
 * Anything with real design or blast-radius risk stays strong.
 *
 *   - P0/P1, or size M+ (unsized ranks as L)            → strong
 *   - XS anything, or S docs/test/chore/style/ci-shaped → cheap
 *   - remaining S code changes                          → strong
 */
export const sessionTier = (
  iss: Pick<SelectableIssue, "labels" | "size" | "priority" | "title">,
): "strong" | "cheap" => {
  if (iss.priority <= 1 || iss.size >= SIZE_RANK.M!) return "strong";
  const mechanical =
    /^(docs|test|chore|style|ci)\b/i.test(iss.title) || iss.labels.includes("documentation");
  if (iss.size === SIZE_RANK.XS! || mechanical) return "cheap";
  return "strong";
};

/**
 * The heuristic EFFORT for an issue, from the same tier split as the model. Kept as its own function
 * (rather than folded into the model pick) because the two axes are independently configurable: a repo
 * may want one model at two efforts, or two models at one effort.
 */
export const pickSessionEffort = (
  iss: Pick<SelectableIssue, "labels" | "size" | "priority" | "title">,
  efforts: { strong: string; cheap: string },
): string => (sessionTier(iss) === "strong" ? efforts.strong : efforts.cheap);

/**
 * The heuristic model for an issue. Generalized from the source loop's hardcoded opus/sonnet split:
 * the caller supplies the two model ids, so the policy is portable across runners.
 */
export const pickSessionModel = (
  iss: Pick<SelectableIssue, "labels" | "size" | "priority" | "title">,
  models: { strong: string; cheap: string },
): string => (sessionTier(iss) === "strong" ? models.strong : models.cheap);

/**
 * Value of a `loop:*` axis label, or undefined. AMBIGUITY IS A FALLBACK: two labels naming different
 * values for the same axis (a leftover plus a new one) has no defensible winner, so both are ignored and
 * the axis falls through to config — better a predictable default than an arbitrary pick.
 */
const labelValue = (labels: string[], prefix: string): string | undefined => {
  const values = new Set(
    labels
      .filter((l) => l.toLowerCase().startsWith(prefix))
      .map((l) => l.slice(prefix.length).trim().toLowerCase())
      .filter(Boolean),
  );
  return values.size === 1 ? [...values][0] : undefined;
};

const resolveRole = (
  iss: Pick<SelectableIssue, "labels" | "size" | "priority" | "title">,
  role: RunnerRole,
  defaults: RoleDefaults,
): SessionPlan => {
  const p = LABEL_PREFIXES[role];

  // Runner first: it decides which allow-list the model and effort values are validated against.
  const runnerLabel = labelValue(iss.labels, p.runner);
  const runner = runnerLabel && isRunnerName(runnerLabel) ? runnerLabel : defaults.runner;
  const runnerSource: PolicySource = runner === runnerLabel ? "label" : "config";

  // `loop:model-*` predates the four-axis vocabulary and still means "the implement model".
  const modelLabel =
    labelValue(iss.labels, p.model) ??
    (role === "implement" ? labelValue(iss.labels, LABEL_PREFIXES.legacyModel) : undefined);
  // A model id is an opaque vendor token, so validateModel is shape-only — it cannot tell that "sonnet"
  // is meaningless to codex. So when a LABEL switched the runner away from the configured one, every
  // config-supplied model default is discarded: those ids were authored for a different vendor, and
  // forwarding them produces `codex -m sonnet`, which dies as a generic implement failure. Effort needs
  // no such guard — RUNNER_EFFORTS validates it per runner. Label-supplied models are honored as-is:
  // whoever writes `loop:impl-runner-codex` alongside `loop:impl-model-*` picked both deliberately.
  const runnerSwitchedByLabel = runnerSource === "label" && runner !== defaults.runner;
  const fromLabel = validateModel(runner, modelLabel);
  const fromConfig = runnerSwitchedByLabel ? undefined : validateModel(runner, defaults.model);
  const heuristic =
    !runnerSwitchedByLabel && defaults.strongModel && defaults.cheapModel
      ? validateModel(
          runner,
          pickSessionModel(iss, { strong: defaults.strongModel, cheap: defaults.cheapModel }),
        )
      : undefined;
  const model = fromLabel ?? fromConfig ?? heuristic;
  const modelSource: PolicySource = fromLabel
    ? "label"
    : fromConfig
      ? "config"
      : heuristic
        ? "heuristic"
        : "runner-default"; // nothing resolved → omit the flag, let the runner pick

  // Same precedence and same runner-switch guard as the model: efforts are per-runner vocabularies
  // (`xhigh` is meaningless to codex), and validateEffort already rejects a value the runner does not
  // know, so a label-switched runner simply falls through to its own default rather than inheriting a
  // word from another vendor.
  const effortLabel = validateEffort(runner, labelValue(iss.labels, p.effort));
  const effortConfig = runnerSwitchedByLabel ? undefined : validateEffort(runner, defaults.effort);
  const effortHeuristic =
    !runnerSwitchedByLabel && defaults.strongEffort && defaults.cheapEffort
      ? validateEffort(
          runner,
          pickSessionEffort(iss, { strong: defaults.strongEffort, cheap: defaults.cheapEffort }),
        )
      : undefined;
  const effort = effortLabel ?? effortConfig ?? effortHeuristic;
  const effortSource: PolicySource = effortLabel
    ? "label"
    : effortConfig
      ? "config"
      : effortHeuristic
        ? "heuristic"
        : "runner-default";

  return {
    runner,
    model,
    effort,
    source: { runner: runnerSource, model: modelSource, effort: effortSource },
  };
};

/** Resolve both sessions for one issue. Pure: no clock, no env, no spawn. */
export const resolveSessionPolicy = (
  iss: Pick<SelectableIssue, "labels" | "size" | "priority" | "title">,
  defaults: PolicyDefaults,
): ResolvedPolicy => ({
  implement: resolveRole(iss, "implement", defaults.implement),
  review: resolveRole(iss, "review", defaults.review),
});

/** One-line rendering for `plan`, e.g. `claude/opus/high(label)`. */
export const formatSessionPlan = (p: SessionPlan): string =>
  `${p.runner}/${p.model ?? "default"}/${p.effort ?? "default"} (${p.source.runner[0]}${p.source.model[0]}${p.source.effort[0]})`;
