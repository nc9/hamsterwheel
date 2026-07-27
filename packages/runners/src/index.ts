/**
 * @hamsterwheel/runners
 *
 * Thin abstraction over the headless agent CLIs (claude · codex · opencode). The core is a PURE argv
 * builder: model and effort values arrive from GitHub labels and config — untrusted, repo-controlled
 * text — so every value is allow-listed or regex-validated before it reaches a spawn, and argv is always
 * an array (never a shell string). Output from all three is normalized to one shape so the gate kit's
 * parsers work unchanged.
 */
export {
  type RunnerName,
  type RunnerRole,
  type RunnerCapabilities,
  RUNNERS,
  RUNNER_CAPABILITIES,
  RUNNER_EFFORTS,
  isRunnerName,
  validateEffort,
  validateModel,
} from "./runner.ts";
export { type RunnerSpec, READ_ONLY_TOOLS, buildRunnerArgs } from "./args.ts";
export { type RunnerOutput, parseRunnerOutput, contractLine } from "./output.ts";
export {
  type RunnerProbe,
  type RunnerLookup,
  type DetectedRunner,
  detectRunners,
  systemRunnerLookup,
} from "./detect.ts";
export { type RunResult, run, git, whichBin, sleep } from "./exec.ts";
