import {
  RUNNER_CAPABILITIES,
  type RunnerName,
  type RunnerRole,
  validateEffort,
  validateModel,
} from "./runner.ts";

/** Read-only tool set for the adversarial rubric session: verify the tree, never touch it. */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

export type RunnerSpec = {
  runner: RunnerName;
  role: RunnerRole;
  /** The full prompt. Passed as ONE argv element — never interpolated into a shell string. */
  prompt: string;
  /** Working directory for the spawn. Not part of argv; carried here so callers pass one object around. */
  cwd: string;
  model?: string;
  effort?: string;
  /** claude only: the scoped tool allow-list for an implement session (ignored when readOnly). */
  allowedTools?: string[];
  /** Constrain the session to read-only tools. Only claude can enforce this (RUNNER_CAPABILITIES). */
  readOnly?: boolean;
  /** claude only: opt in to full `bypassPermissions` instead of the scoped allow-list. Loud, supervised. */
  bypassPermissions?: boolean;
  /** codex only: JSON Schema file pinning the final response shape (used for the rubric verdict). */
  outputSchemaPath?: string;
};

/**
 * Build the exact argv for a headless runner session, binary included (`["claude", "-p", …]`), so the
 * result can be handed straight to `Bun.spawn` or used as a sandbox `command`.
 *
 * PURE + SECURITY-CRITICAL (unit-tested per runner and role). Every element is a separate array member:
 * nothing is ever concatenated into a shell string, so a hostile label value cannot break out. Model and
 * effort are re-validated HERE — the last line of defense — and a value that fails validation is DROPPED
 * (the flag is omitted, the runner falls back to its own default) rather than passed through: an invalid
 * value on argv would exit non-zero and read as a generic session failure.
 *
 * Structured output is always requested (claude `--output-format json`, codex `--json`, opencode
 * `--format json`) so parseRunnerOutput can recover the final message uniformly across runners.
 */
export const buildRunnerArgs = (spec: RunnerSpec): string[] => {
  const model = validateModel(spec.runner, spec.model);
  const effort = validateEffort(spec.runner, spec.effort);
  const readOnly = spec.readOnly ?? spec.role === "review";

  if (spec.runner === "claude") {
    const argv = ["claude", "-p", spec.prompt, "--output-format", "json"];
    if (model) argv.push("--model", model);
    if (effort) argv.push("--effort", effort);
    // Read-only wins over every other permission setting: the rubric grader must not be able to edit the
    // tree it is grading, not even under --bypass.
    if (readOnly) {
      argv.push("--permission-mode", "acceptEdits", "--allowedTools", READ_ONLY_TOOLS.join(" "));
    } else if (spec.bypassPermissions) {
      argv.push("--permission-mode", "bypassPermissions");
    } else {
      argv.push("--permission-mode", "acceptEdits");
      // No allow-list configured → leave the flag off entirely rather than passing an empty one, which
      // claude reads as "no tools" and would silently produce a session that can't do anything.
      if (spec.allowedTools?.length) argv.push("--allowedTools", spec.allowedTools.join(" "));
    }
    return argv;
  }

  if (spec.runner === "codex") {
    const argv = ["codex", "exec", spec.prompt, "--json"];
    if (model) argv.push("-m", model);
    // Reasoning effort rides the generic config override, not a dedicated flag.
    if (effort) argv.push("-c", `model_reasoning_effort=${effort}`);
    if (spec.outputSchemaPath && RUNNER_CAPABILITIES.codex.supportsOutputSchema)
      argv.push("--output-schema", spec.outputSchemaPath);
    return argv;
  }

  const argv = ["opencode", "run", spec.prompt, "--format", "json"];
  if (model) argv.push("-m", model);
  if (effort) argv.push("--variant", effort);
  return argv;
};
