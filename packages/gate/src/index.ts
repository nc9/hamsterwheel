/**
 * @hamsterwheel/gate
 *
 * Pure, heavily-tested merge-gate policy (plus a couple of impure git salvage helpers). Deterministic
 * gate order: CI → migration → blocking review findings → rubric; every heuristic errs toward blocking
 * (a false positive routes to a human, a false negative merges a bad PR).
 */
export { INJECTION_MARKERS, screenInjection, fence } from "./untrusted.ts";
export {
  type GateSignals,
  type GateAction,
  BLOCKING_REVIEW_RE,
  mergeDecision,
  detectMigration,
  reviewBlockingFindings,
} from "./gate.ts";
export {
  type RubricVerdict,
  EXECUTION_DEPENDENT_RE,
  parseRubricVerdict,
  isExecutionDependent,
  applyCiToRubric,
} from "./rubric.ts";
export {
  type ImplementOutcome,
  PR_URL_RE,
  RESOLVED_SIGNAL_RE,
  classifyImplement,
} from "./outcome.ts";
export {
  type WipBranchInfo,
  type PruneAction,
  type PruneDecision,
  WIP_BRANCH_RE,
  wipBranchName,
  parseWipBranches,
  classifyWipBranch,
  worktreeAddArgs,
  worktreeHasChanges,
  preserveWorktreeChanges,
} from "./salvage.ts";
