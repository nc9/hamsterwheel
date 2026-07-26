// The agent CLIs the loop can drive, and the per-runner vocabularies that guard every value reaching a
// spawn. Model/effort values arrive from GitHub LABELS and from `hamsterwheel.toml` — both are repo-
// controlled, untrusted text — so nothing here accepts a free-form string: everything is allow-listed
// or regex-validated, and the caller gets `undefined` (fall back to the heuristic) rather than a value
// that would land on argv.

export const RUNNERS = ["claude", "codex", "opencode"] as const;
export type RunnerName = (typeof RUNNERS)[number];

export const isRunnerName = (v: string): v is RunnerName =>
  (RUNNERS as readonly string[]).includes(v);

export type RunnerRole = "implement" | "review";

/**
 * What each runner can actually enforce, so the driver never assumes a guarantee it doesn't have.
 * `enforcesReadOnly`: only claude exposes a verified tool allow-list flag (`--allowedTools`), so it is
 * the only runner whose adversarial rubric session is tool-constrained by construction. codex/opencode
 * reviewers run with their own defaults — the driver warns rather than silently pretending otherwise.
 * `supportsOutputSchema`: codex `--output-schema <file>` pins the final response to a JSON Schema, which
 * beats prose-parsing the rubric verdict (parseRubricVerdict stays the fallback for the others).
 */
export type RunnerCapabilities = {
  enforcesReadOnly: boolean;
  supportsOutputSchema: boolean;
  /** Model ids this runner takes are provider-qualified (`provider/model`), so `/` is legal. */
  slashInModel: boolean;
};
export const RUNNER_CAPABILITIES: Record<RunnerName, RunnerCapabilities> = {
  claude: { enforcesReadOnly: true, supportsOutputSchema: false, slashInModel: false },
  codex: { enforcesReadOnly: false, supportsOutputSchema: true, slashInModel: false },
  opencode: { enforcesReadOnly: false, supportsOutputSchema: false, slashInModel: true },
};

// The three CLIs do NOT share an effort vocabulary — a level valid for one is rejected (or worse,
// silently misread) by another. Allow-list per runner; anything else is refused before the spawn.
export const RUNNER_EFFORTS: Record<RunnerName, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high"],
  opencode: ["minimal", "low", "medium", "high", "max"],
};

/** Validated effort for a runner, or undefined when the value is unknown/typo'd/empty (→ caller falls back). */
export const validateEffort = (
  runner: RunnerName,
  effort: string | undefined,
): string | undefined => {
  if (effort === undefined) return undefined;
  const v = effort.trim().toLowerCase();
  return RUNNER_EFFORTS[runner].includes(v) ? v : undefined;
};

// A model id is an opaque vendor token, so the guard is shape-only: alphanumeric start, then the small
// punctuation set real ids use (`.`, `_`, `-`, `:`), plus `/` for provider-qualified ids. Deliberately
// excludes whitespace, quotes, `$`, `;`, backticks, newlines and every other shell metacharacter — a
// label like `loop:impl-model-$(whoami)` must never reach argv even though argv is passed as an array.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MODEL_SLASH_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/;

/** Validated model id for a runner, or undefined when the value is malformed (→ caller falls back). */
export const validateModel = (
  runner: RunnerName,
  model: string | undefined,
): string | undefined => {
  if (model === undefined) return undefined;
  const v = model.trim();
  const re = RUNNER_CAPABILITIES[runner].slashInModel ? MODEL_SLASH_RE : MODEL_RE;
  return re.test(v) ? v : undefined;
};
