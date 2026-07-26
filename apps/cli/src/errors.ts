/**
 * Run-fatal vs issue-fatal.
 *
 * THE INCIDENT THIS EXISTS FOR: `run --execute --sandbox` was launched without SANDBOX_GITHUB_TOKEN.
 * The sandbox failed closed — correctly — but PER ISSUE: claim → immediate Block → next issue. An entire
 * hand-curated Ready queue was burned into Blocked inside a minute. The security posture was right; the
 * driver was wrong to treat an environment/config error like an implement failure.
 *
 * Rule: a precondition that will fail IDENTICALLY for every item is run-fatal. It aborts the whole run on
 * first occurrence, and the claim is rolled back to Ready — the item is untouched, not blamed. Only a
 * failure that is genuinely about THIS issue may block THIS issue.
 */
export class RunFatalError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "RunFatalError";
  }
}

// Errors thrown from deep inside a session/sandbox/gh call that are environmental by nature. Matching on
// message text is unlovely, but the alternative — every layer re-wrapping — leaves exactly the gap that
// drained the queue. Err toward run-fatal: aborting a run costs one relaunch, mis-blocking costs the
// operator's whole curated queue.
const RUN_FATAL_PATTERNS: [string, RegExp][] = [
  ["sandbox-credentials", /SANDBOX_(GITHUB_TOKEN|ANTHROPIC_API_KEY)/],
  ["sandbox-git-config", /--sandbox: .*credential-bearing config/],
  [
    "docker-missing",
    /\b(docker|Cannot connect to the Docker daemon)\b.*\b(not found|no such file|not running|cannot connect)/i,
  ],
  ["runner-missing", /spawn .* ENOENT|command not found|executable file not found/i],
  [
    "gh-auth",
    /gh auth|authentication failed|Bad credentials|HTTP 401|requires the .project. scope|HTTP 403/i,
  ],
  [
    "board-shape",
    /board field "[^"]*" not found|status option "[^"]*" not on the board|project .* not found/,
  ],
  ["install-cmd", /install_cmd "[^"]*" failed/],
];

/** The run-fatal classification for an arbitrary thrown value, or null when it is issue-fatal. */
export const runFatalReason = (e: unknown): string | null => {
  if (e instanceof RunFatalError) return e.message;
  const text = e instanceof Error ? `${e.message}` : String(e);
  const hit = RUN_FATAL_PATTERNS.find(([, re]) => re.test(text));
  return hit ? `${hit[0]}: ${text}` : null;
};

export const isRunFatal = (e: unknown): boolean => runFatalReason(e) !== null;
