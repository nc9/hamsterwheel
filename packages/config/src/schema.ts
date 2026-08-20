import { RUNNERS, RUNNER_EFFORTS, isRunnerName, type RunnerName } from "@hamsterwheel/runners";

/**
 * `hamsterwheel.toml` → a validated `Config`.
 *
 * Everything the driver needs that is repo-specific lives here — nothing about a particular repo's board
 * field names, review bot, migration layout or model policy is hardcoded in the driver. Validation
 * collects EVERY problem before throwing so a first run reports the whole list, not one field per attempt.
 */

export type StatusNames = {
  draft: string;
  ready: string;
  inProgress: string;
  inReview: string;
  blocked: string;
  done: string;
};

/** Blocked-reason option names, keyed by the reason the gate emits (`mergeDecision().reason` et al). */
export type BlockedReasonNames = {
  needsCriteria: string;
  needsHuman: string;
  needsDecision: string;
  depOpen: string;
  ciRed: string;
  /**
   * Option name for `ci-timeout`. DEFAULTS TO THE RESOLVED `ciRed` NAME, not to a literal
   * "ci-timeout": the gate distinguishes the two reasons, but a board provisioned before that split
   * has no such option, and writing an unknown option name fails the whole status update. Set
   * `board.blocked_reasons.ci_timeout` once the option exists to separate them on the board too; the
   * gate detail and the run log name it distinctly either way.
   */
  ciTimeout: string;
  rubricFail: string;
};

/**
 * A "never auto-merge, park for a human" tripwire. Fires when the PR's changed files match `pathsRe`
 * OR the issue carries one of `labels` (case-insensitive). At least one of the two is present.
 */
export type HumanRule = {
  name: string;
  pathsRe?: RegExp;
  labels?: string[];
};

/**
 * How much a server-side PR review is worth to the merge gate.
 *
 * - `required` — a review covering the current head must exist. Strictest, and the right choice only
 *   when a review bot reliably posts on every PR.
 * - `optional` — a covering review is honoured if present, and its absence is not a blocker. CI plus
 *   the adversarial rubric grader carry the decision.
 * - `off`  — reviews are never fetched at all.
 *
 * A submitted review in CHANGES_REQUESTED state blocks under `required` AND `optional`: that is a human
 * explicitly withholding approval, not a finding whose severity the gate gets to weigh. `off` does not
 * honour it, because `off` issues no review API calls at all — that is the point of the mode, and the
 * cost of choosing it. Use branch protection if a human veto must hold regardless of loop config.
 */
export const REVIEW_MODES = ["required", "optional", "off"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];
const isReviewMode = (v: string): v is ReviewMode =>
  (REVIEW_MODES as readonly string[]).includes(v);

export type RoleConfig = {
  runner: RunnerName;
  model?: string;
  /** Flat effort for every issue. Mutually exclusive with the `strong`/`cheap` pair — see readRole. */
  effort?: string;
  strongModel?: string;
  cheapModel?: string;
  strongEffort?: string;
  cheapEffort?: string;
};

export type Config = {
  /** `owner/name` of the repo whose issues the loop works. */
  repo: string;
  /** Owner segment of `repo` — also the default Projects v2 owner. */
  owner: string;
  baseBranch: string;
  branchPrefix: string;
  /** Extra repos whose open issues `triage --sync` folds onto the board (e.g. a public triage inbox). */
  sourceRepos: string[];
  project: { owner: string; title?: string; number?: number };
  board: {
    statusField: string;
    ownerField: string;
    blockedReasonField: string;
    status: StatusNames;
    blockedReasons: BlockedReasonNames;
  };
  review: { mode: ReviewMode; bot: string; blockingSeverityRe: RegExp };
  /** `[[human]]` rules — any hit parks the PR as Blocked: needs-human instead of auto-merging. */
  humanRules: HumanRule[];
  /**
   * Block an issue a person has already claimed — assigned to someone, commented on by anyone outside
   * the org, or carrying `handsOffLabel` — instead of working it.
   *
   * On for anyone who does not opt out, because the failure it prevents is the expensive kind: the loop
   * cannot see assignees or comments at all, so without this a volunteer's issue looks identical to an
   * untouched one. `false` restores the old behaviour for a private board that would rather not spend
   * the check.
   */
  communityGuard: boolean;
  /** Label that permanently excludes an issue from the loop, whoever else has touched it. */
  handsOffLabel: string;
  criteriaHeading: string;
  /**
   * `[scripts]` lifecycle table (Conductor-style). `setup` runs in the lane after every acquire —
   * cold create AND warm reuse — with `HAMSTER_*` context env vars. Absent → no setup step.
   * `run` / `archive` / `maintenance` are reserved for later.
   */
  scripts: { setup?: string };
  smokeCmd?: string;
  /**
   * Append `-s` (a `Signed-off-by` trailer) to every commit a session makes.
   *
   * Required by any repo running a DCO check — without it EVERY loop PR fails the gate, and the
   * failure names the commit rather than the config, so it reads as an agent mistake. The trailer must
   * match the commit's mailmap-applied author, so set the repo's `user.email` to whatever the mailmap
   * resolves to as well; a mismatched identity can never pass no matter how correctly it is signed.
   */
  commitSignoff: boolean;
  runners: { implement: RoleConfig; review: RoleConfig };
  allowedTools: string[];
  sessionTimeoutMs: number;
  ciTimeoutMs: number;
  maxDiffBytes: number;
  /** Hard cap on review-fix rounds. The reviewer is stateless, so unbounded it never converges. */
  maxReviewRounds: number;
  maxIterations: number;
  worktreeRoot: string;
  /**
   * Size of the persistent lane pool under `worktreeRoot` (lane-0…lane-N-1), and the number of issues
   * worked concurrently. 1 (default) is the original serial loop, allocating no locks at all.
   *
   * Each lane is a full worktree with its own `node_modules` and build caches, so the cost of a lane is
   * disk plus one cold `scripts.setup`; the benefit is that implement sessions (12-60 minutes each)
   * overlap instead of queueing. Bounded in practice by what the machine can run concurrently and by
   * API quota, which is consumed per in-flight pipeline.
   */
  worktreeLanes: number;
};

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid hamsterwheel config:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

const DEFAULT_STATUS: StatusNames = {
  draft: "Draft",
  ready: "Ready",
  inProgress: "In Progress",
  inReview: "In Review",
  blocked: "Blocked",
  done: "Done",
};
const DEFAULT_BLOCKED: BlockedReasonNames = {
  needsCriteria: "needs-criteria",
  needsHuman: "needs-human",
  needsDecision: "needs-decision",
  depOpen: "dep-open",
  ciRed: "ci-red",
  ciTimeout: "ci-red", // see BlockedReasonNames.ciTimeout — deliberately not its own default option
  rubricFail: "rubric-fail",
};
/** Default scoped tool allow-list for a claude implement session. No blanket `Bash(*)`, no arbitrary-read
 * shells (`cat`/`rg`/`ls` would let the session read `~/.config/gh/hosts.yml`; the scoped Read/Grep/Glob
 * tools cover project files without that). Still NOT isolation — that is the sandbox's job. */
export const DEFAULT_ALLOWED_TOOLS = [
  "Edit",
  "Read",
  "Write",
  "Glob",
  "Grep",
  "TodoWrite",
  "Bash(git:*)",
  "Bash(gh:*)",
];

// ---- primitive readers: each records a problem and returns undefined rather than throwing ----

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => typeof v === "object" && v !== null && !Array.isArray(v);

class Reader {
  readonly problems: string[] = [];
  constructor(private readonly root: Bag) {}

  private at(path: string): unknown {
    let cur: unknown = this.root;
    for (const seg of path.split(".")) {
      if (!isBag(cur)) return undefined;
      cur = cur[seg];
    }
    return cur;
  }

  fail(msg: string): void {
    this.problems.push(msg);
  }

  str(path: string, fallback?: string): string {
    const v = this.at(path);
    if (v === undefined) {
      if (fallback !== undefined) return fallback;
      this.fail(`${path} is required (string)`);
      return "";
    }
    if (typeof v !== "string" || !v.trim()) {
      this.fail(`${path} must be a non-empty string (got ${JSON.stringify(v)})`);
      return fallback ?? "";
    }
    return v.trim();
  }

  optStr(path: string): string | undefined {
    const v = this.at(path);
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !v.trim()) {
      this.fail(`${path} must be a non-empty string when set (got ${JSON.stringify(v)})`);
      return undefined;
    }
    return v.trim();
  }

  num(path: string, fallback: number, min = 1): number {
    const v = this.at(path);
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min) {
      this.fail(`${path} must be a finite number >= ${min} (got ${JSON.stringify(v)})`);
      return fallback;
    }
    return v;
  }

  optNum(path: string): number | undefined {
    const v = this.at(path);
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      this.fail(`${path} must be a positive integer when set (got ${JSON.stringify(v)})`);
      return undefined;
    }
    return v;
  }

  bool(path: string, fallback: boolean): boolean {
    const v = this.at(path);
    if (v === undefined) return fallback;
    // A typo'd bool must fail loudly, not coerce. `commit_signoff = "true"` silently falling back to
    // false would produce PRs that fail DCO on every commit, with nothing in the config pointing at why.
    if (typeof v !== "boolean") {
      this.fail(`${path} must be a boolean (got ${JSON.stringify(v)})`);
      return fallback;
    }
    return v;
  }

  strList(path: string, fallback: string[]): string[] {
    const v = this.at(path);
    if (v === undefined) return fallback;
    if (!Array.isArray(v) || v.some((e) => typeof e !== "string" || !e.trim())) {
      this.fail(`${path} must be an array of non-empty strings`);
      return fallback;
    }
    return (v as string[]).map((e) => e.trim());
  }

  /** A user-supplied pattern, always compiled case-insensitively (paths and severities vary in case). */
  regex(path: string, fallback: RegExp): RegExp {
    const raw = this.at(path);
    if (raw === undefined) return fallback;
    if (typeof raw !== "string" || !raw.trim()) {
      this.fail(`${path} must be a non-empty regex string`);
      return fallback;
    }
    try {
      return new RegExp(raw, "i");
    } catch (e) {
      this.fail(`${path} is not a valid regular expression: ${String(e)}`);
      return fallback;
    }
  }
}

const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
// Branch prefixes end up in a ref name; keep them to the safe subset git and the WIP-branch regex expect.
const BRANCH_PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const readReviewMode = (r: Reader, path: string, fallback: ReviewMode): ReviewMode => {
  const raw = r.optStr(path);
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase();
  if (isReviewMode(v)) return v;
  r.fail(`${path} must be one of ${REVIEW_MODES.join(" | ")} (got "${raw}")`);
  return fallback;
};

const readRole = (
  r: Reader,
  path: string,
  fallback: { runner: RunnerName; strongModel?: string; cheapModel?: string },
): RoleConfig => {
  const runnerRaw = r.optStr(`${path}.runner`);
  let runner = fallback.runner;
  if (runnerRaw !== undefined) {
    if (isRunnerName(runnerRaw)) runner = runnerRaw;
    else r.fail(`${path}.runner must be one of ${RUNNERS.join(" | ")} (got "${runnerRaw}")`);
  }
  // Effort vocabularies differ per runner; a mismatch here is a config typo worth surfacing loudly,
  // unlike a label typo (which silently falls back — a human can't fix a label mid-run).
  const readEffort = (key: string): string | undefined => {
    const v = r.optStr(`${path}.${key}`);
    if (v !== undefined && !RUNNER_EFFORTS[runner].includes(v.toLowerCase()))
      r.fail(
        `${path}.${key} "${v}" is not valid for runner ${runner} (${RUNNER_EFFORTS[runner].join(" | ")})`,
      );
    return v;
  };
  const effort = readEffort("effort");
  const strongEffort = readEffort("strong_effort");
  const cheapEffort = readEffort("cheap_effort");
  // A flat `effort` outranks the tier pair in resolution, so setting both means the pair is dead
  // config that reads as if it were doing something. Fail rather than silently ignore it.
  if (effort !== undefined && (strongEffort !== undefined || cheapEffort !== undefined))
    r.fail(
      `${path}.effort applies one effort to every issue, which overrides ${path}.strong_effort/cheap_effort — set either the flat value or the tier pair, not both`,
    );
  return {
    runner,
    model: r.optStr(`${path}.model`),
    effort,
    strongModel: r.optStr(`${path}.strong_model`) ?? fallback.strongModel,
    cheapModel: r.optStr(`${path}.cheap_model`) ?? fallback.cheapModel,
    strongEffort,
    cheapEffort,
  };
};

/** Parse the `[scripts]` lifecycle table. Only `setup` exists today; unknown keys are errors so a
 * typo (or a future key on an old version) never silently no-ops. */
const readScripts = (r: Reader, raw: unknown): { setup?: string } => {
  if (raw === undefined) return {};
  if (!isBag(raw)) {
    r.fail("scripts must be a table ([scripts])");
    return {};
  }
  for (const k of Object.keys(raw))
    if (k !== "setup")
      r.fail(
        `scripts.${k} is not supported — only \`setup\` is (run/archive/maintenance are reserved for later)`,
      );
  const setup = r.optStr("scripts.setup");
  return setup ? { setup } : {};
};

/** Parse the `[[human]]` array of tables. Every problem is recorded on the reader, none thrown. */
const readHumanRules = (r: Reader, raw: unknown): HumanRule[] => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((e) => !isBag(e))) {
    r.fail("human must be an array of tables ([[human]] blocks)");
    return [];
  }
  const rules: HumanRule[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const bag = entry as Bag;
    const at = `human[${i}]`;
    for (const k of Object.keys(bag))
      if (!["name", "paths", "labels"].includes(k)) r.fail(`${at}.${k} is not a known key`);
    const name = bag["name"];
    if (typeof name !== "string" || !name.trim()) {
      r.fail(`${at}.name is required (a short identifier, e.g. "prod-migration")`);
      return;
    }
    const id = name.trim();
    if (seen.has(id.toLowerCase())) r.fail(`${at}.name "${id}" is duplicated`);
    seen.add(id.toLowerCase());

    let pathsRe: RegExp | undefined;
    const paths = bag["paths"];
    if (paths !== undefined) {
      if (typeof paths !== "string" || !paths.trim())
        r.fail(`${at}.paths must be a non-empty regex string`);
      else
        try {
          pathsRe = new RegExp(paths, "i");
        } catch (e) {
          r.fail(`${at}.paths is not a valid regular expression: ${String(e)}`);
        }
    }

    let labels: string[] | undefined;
    const rawLabels = bag["labels"];
    if (rawLabels !== undefined) {
      if (
        !Array.isArray(rawLabels) ||
        rawLabels.length === 0 ||
        rawLabels.some((l) => typeof l !== "string" || !l.trim())
      )
        r.fail(`${at}.labels must be a non-empty array of non-empty strings`);
      else labels = (rawLabels as string[]).map((l) => l.trim());
    }

    if (pathsRe === undefined && labels === undefined) {
      r.fail(`${at} ("${id}") needs paths and/or labels — a rule that can never fire is a typo`);
      return;
    }
    rules.push({ name: id, ...(pathsRe ? { pathsRe } : {}), ...(labels ? { labels } : {}) });
  });
  return rules;
};

/**
 * Validate a parsed TOML document into a `Config`. Pure — no file IO, no env, no clock — so the whole
 * validation surface is unit-testable. Throws `ConfigError` carrying every problem found.
 */
export const parseConfig = (raw: unknown, opts: { home?: string } = {}): Config => {
  if (!isBag(raw))
    throw new ConfigError(["config must be a TOML table (got a non-object document)"]);
  const r = new Reader(raw);

  const repo = r.str("repo");
  if (repo && !REPO_SLUG_RE.test(repo)) r.fail(`repo must be an "owner/name" slug (got "${repo}")`);
  const owner = repo.split("/")[0] ?? "";

  const branchPrefix = r.str("branch_prefix", "loop");
  if (branchPrefix && !BRANCH_PREFIX_RE.test(branchPrefix))
    r.fail(`branch_prefix must be a git-ref-safe token (got "${branchPrefix}")`);

  const projectNumber = r.optNum("project.number");
  const projectTitle = r.optStr("project.title");
  if (projectNumber === undefined && projectTitle === undefined)
    r.fail("project.number or project.title is required — the loop needs a board to read");

  const sourceRepos = r.strList("source_repos", repo ? [repo] : []);
  for (const s of sourceRepos)
    if (!REPO_SLUG_RE.test(s)) r.fail(`source_repos entry "${s}" must be an "owner/name" slug`);

  const home = opts.home ?? process.env.HOME ?? "";
  const cfg: Config = {
    repo,
    owner,
    baseBranch: r.str("base_branch", "main"),
    branchPrefix,
    sourceRepos,
    project: {
      owner: r.optStr("project.owner") ?? owner,
      title: projectTitle,
      number: projectNumber,
    },
    board: {
      statusField: r.str("board.status_field", "Status"),
      ownerField: r.str("board.owner_field", "Owner"),
      blockedReasonField: r.str("board.blocked_reason_field", "Blocked reason"),
      status: {
        draft: r.str("board.status.draft", DEFAULT_STATUS.draft),
        ready: r.str("board.status.ready", DEFAULT_STATUS.ready),
        inProgress: r.str("board.status.in_progress", DEFAULT_STATUS.inProgress),
        inReview: r.str("board.status.in_review", DEFAULT_STATUS.inReview),
        blocked: r.str("board.status.blocked", DEFAULT_STATUS.blocked),
        done: r.str("board.status.done", DEFAULT_STATUS.done),
      },
      blockedReasons: {
        needsCriteria: r.str("board.blocked_reasons.needs_criteria", DEFAULT_BLOCKED.needsCriteria),
        needsHuman: r.str("board.blocked_reasons.needs_human", DEFAULT_BLOCKED.needsHuman),
        needsDecision: r.str("board.blocked_reasons.needs_decision", DEFAULT_BLOCKED.needsDecision),
        depOpen: r.str("board.blocked_reasons.dep_open", DEFAULT_BLOCKED.depOpen),
        ciRed: r.str("board.blocked_reasons.ci_red", DEFAULT_BLOCKED.ciRed),
        // Falls back to whatever ci_red resolved to (possibly itself overridden), never to a literal
        // that the board may not carry.
        ciTimeout: r.str(
          "board.blocked_reasons.ci_timeout",
          r.str("board.blocked_reasons.ci_red", DEFAULT_BLOCKED.ciRed),
        ),
        rubricFail: r.str("board.blocked_reasons.rubric_fail", DEFAULT_BLOCKED.rubricFail),
      },
    },
    review: {
      // Default `optional`, deliberately the looser value. `required` reads safer but wedges every
      // fresh adoption: a repo with no review workflow still gets the `claude[bot]` default here, so
      // nothing ever matches, every PR parks as needs-decision, and the reason it prints ("no review
      // of the current head") is indistinguishable from a review bot that is merely broken. The gate
      // does not rest on CI alone under `optional` — the rubric grader is a fresh adversarial session
      // that did not write the code, and CHANGES_REQUESTED still blocks in every mode.
      mode: readReviewMode(r, "review.mode", "optional"),
      bot: r.str("review.bot", "claude[bot]"),
      blockingSeverityRe: r.regex(
        "review.blocking_severity_regex",
        /\(\s*(high|critical)\s*\)|🔴|\[(critical|high)\]|severity:\s*(high|critical)/i,
      ),
    },
    humanRules: readHumanRules(r, raw.human),
    communityGuard: r.bool("community_guard", true),
    handsOffLabel: r.str("hands_off_label", "loop:hands-off"),
    criteriaHeading: r.str("criteria_heading", "Acceptance Criteria"),
    scripts: readScripts(r, raw.scripts),
    smokeCmd: r.optStr("smoke_cmd"),
    commitSignoff: r.bool("commit_signoff", false),
    runners: {
      implement: readRole(r, "runners.implement", { runner: "claude" }),
      review: readRole(r, "runners.review", { runner: "claude" }),
    },
    allowedTools: r.strList("allowed_tools", DEFAULT_ALLOWED_TOOLS),
    sessionTimeoutMs: r.num("session_timeout_ms", 60 * 60 * 1000, 60_000),
    ciTimeoutMs: r.num("ci_timeout_ms", 15 * 60 * 1000, 30_000),
    maxDiffBytes: r.num("max_diff_bytes", 60_000, 1000),
    // 4 by design, not by taste: measured on a ~50-line PR the review workflow ran 6 rounds with
    // findings 3→6→3→3→3→3; substantive fixes were exhausted by round 3-4 and rounds 5-6 objected to
    // flags and identifiers that do not exist. 0 disables the fix loop (findings block immediately).
    maxReviewRounds: r.num("max_review_rounds", 4, 0),
    maxIterations: r.num("max_iterations", 50),
    worktreeRoot: r.str("worktree_root", `${home}/.hamsterwheel/worktrees`),
    worktreeLanes: r.num("worktree_lanes", 1, 1),
  };
  // Hard break from the pre-[[human]] config surface: silently ignoring the old key would drop the
  // migration guard without a sound.
  if (raw.install_cmd !== undefined)
    r.fail(
      'install_cmd was replaced by the [scripts] table — e.g.\n      [scripts]\n      setup = "bun install"   # or "./scripts/setup.sh"; runs in the lane on every acquire, argv-exec\'d (no shell)',
    );
  if (raw.migration_path_regex !== undefined)
    r.fail(
      'migration_path_regex was replaced by [[human]] rules — e.g.\n      [[human]]\n      name = "prod-migration"\n      paths = "(^|/)(migrations|drizzle)/"',
    );
  // No safe default: a repo with migrations and no path rule would auto-merge schema changes, which is
  // the one thing that must never happen. Label-only rules don't satisfy this — labels are optional
  // human input; paths are facts about the diff.
  if (!cfg.humanRules.some((h) => h.pathsRe !== undefined))
    r.fail(
      "at least one [[human]] rule with `paths` is required — without it a PR touching a schema migration could auto-merge",
    );

  if (r.problems.length) throw new ConfigError(r.problems);
  return cfg;
};
