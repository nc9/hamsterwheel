/**
 * @hamsterwheel/gate
 *
 * Pure, heavily-tested merge-gate policy (plus a couple of impure git salvage helpers). Deterministic
 * gate order: CI → human-review rules → blocking review findings → rubric; every heuristic errs toward
 * blocking (a false positive routes to a human, a false negative merges a bad PR).
 */
export { INJECTION_MARKERS, screenInjection, fence } from "./untrusted.ts";
export {
  type GateSignals,
  type GateAction,
  type HumanRule,
  BLOCKING_REVIEW_RE,
  mergeDecision,
  matchHumanRules,
  reviewBlockingFindings,
  reviewCoversHead,
} from "./gate.ts";
export {
  type RubricVerdict,
  EXECUTION_DEPENDENT_RE,
  parseRubricVerdict,
  tryParseRubricVerdict,
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
  type ImplementPromptOptions,
  type RubricPromptOptions,
  RESOLVED_SIGNAL,
  buildImplementPrompt,
  buildRubricPrompt,
} from "./prompts.ts";
export {
  type SelectableIssue,
  type IssueComment,
  type HumanClaim,
  ORG_ASSOCIATIONS,
  detectHumanClaim,
  describeHumanClaim,
  PRIORITY_RANK,
  SIZE_RANK,
  UNKNOWN_SIZE_RANK,
  UNKNOWN_PRIORITY_RANK,
  priorityRank,
  sizeRank,
  compareIssues,
  parseDeps,
  hasAcceptanceCriteria,
  isEpicTitle,
} from "./select.ts";
export {
  type PolicySource,
  type SessionPlan,
  type ResolvedPolicy,
  type RoleDefaults,
  type PolicyDefaults,
  LABEL_PREFIXES,
  sessionTier,
  pickSessionEffort,
  pickSessionModel,
  resolveSessionPolicy,
  formatSessionPlan,
} from "./policy.ts";
export {
  type CommitEntry,
  type BumpSuggestion,
  type NotesLine,
  type Section,
  type NotesInput,
  parseCommitSubject,
  latestSemverTag,
  suggestBump,
  groupSections,
  renderNotes,
  prependChangelog,
} from "./release.ts";
export {
  type WipBranchInfo,
  type PruneAction,
  type PruneDecision,
  WIP_BRANCH_RE,
  wipBranchRe,
  wipBranchName,
  parseWipBranches,
  classifyWipBranch,
  worktreeAddArgs,
  worktreeHasChanges,
  preserveWorktreeChanges,
} from "./salvage.ts";
