import { readFile } from "node:fs/promises";

import type { SessionPlan } from "@hamsterwheel/gate";
import {
  type RunnerOutput,
  type RunnerRole,
  RUNNER_CAPABILITIES,
  buildRunnerArgs,
  git,
  parseRunnerOutput,
  run,
} from "@hamsterwheel/runners";
import {
  SANDBOX_IMAGE,
  SANDBOX_NETWORK,
  buildSandboxArgs,
  resolveSandboxEnv,
  sandboxWorktreeMounts,
  scanGitConfigForCredentials,
} from "@hamsterwheel/sandbox";

/**
 * Spawning a headless agent session — the one place the driver crosses into an untrusted-code boundary.
 *
 * Two paths, both taking the SAME argv from buildRunnerArgs:
 *  - in-process (default): scrubbed env, scoped tool allow-list. Defense-in-depth, NOT isolation.
 *  - `--sandbox`: the argv is exec'd inside a rootless container with only the worktree + its git common
 *    dir mounted and env crossing by name-only allow-list. This is the real boundary.
 */

// Drop obvious secret-bearing vars from the child env (defense-in-depth; NOT a substitute for OS
// isolation — gh/git creds on disk are still reachable). GITHUB_TOKEN/GH_TOKEN go too: with `Bash(gh:*)`
// allow-listed, an inherited token is an exfil/abuse vector, and the child's gh falls back to its own
// stored config auth.
const SECRET_ENV_RE =
  /^(AWS_|GCP_|GOOGLE_|AZURE_|CLOUDFLARE_|CF_|OPENAI_|ANTHROPIC_API|STRIPE_|DATABASE_|INTERNAL_API|R2_|HYPERDRIVE|GITHUB_TOKEN|GH_TOKEN)/i;
export const scrubbedEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(([k, v]) => v !== undefined && !SECRET_ENV_RE.test(k)),
  ) as Record<string, string>;

export type SessionOptions = {
  plan: SessionPlan;
  role: RunnerRole;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  allowedTools?: string[];
  bypassPermissions?: boolean;
  outputSchemaPath?: string;
  sandbox?: boolean;
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
  /**
   * Called periodically while the child runs, so a live session is distinguishable from a wedged one.
   *
   * This is the phase that needed it most and had it least. An implement session is the longest thing
   * the loop does — tens of minutes — and it appends nothing to the run log while it works, so before
   * this the status file went untouched for the whole session and `hamster status` reported a perfectly
   * healthy run as `stale`. A monitoring signal that cries wolf on every normal run is worse than none:
   * it got acted on, and a live run's claim was released out from under it.
   */
  onHeartbeat?: () => void;
};

/** How often a running session touches the status file. Well under the default 180s stale threshold. */
export const SESSION_HEARTBEAT_MS = 30_000;

export type SessionResult = RunnerOutput & { timedOut: boolean; stderr: string };

const gitCommonDir = async (worktree: string): Promise<string> => {
  const r = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktree);
  return r.stdout.trim();
};

/** Build the sandboxed `docker run …` argv for a session, failing closed on anything suspect. */
const sandboxCommand = async (
  worktree: string,
  command: string[],
  env: Record<string, string | undefined>,
): Promise<{ argv: string[]; processEnv: Record<string, string> }> => {
  const { forwardNames, processEnv } = resolveSandboxEnv(env);
  const gitDir = await gitCommonDir(worktree);
  // The git dir is mounted in — refuse if its config could carry host creds across or hijack the push
  // away from the injected token.
  const flags = scanGitConfigForCredentials(
    await readFile(`${gitDir}/config`, "utf8").catch(() => ""),
  );
  if (flags.length)
    throw new Error(
      `--sandbox: ${gitDir}/config carries credential-bearing config (${flags.join(", ")}) that would cross the mount ` +
        "or hijack the push from the injected token. Refusing to run — remove it or use a clean-cloned repo.",
    );
  return {
    argv: [
      "docker",
      ...buildSandboxArgs({
        image: SANDBOX_IMAGE,
        network: SANDBOX_NETWORK,
        workdir: worktree, // identity-mounted, so cwd == the real worktree path
        mounts: sandboxWorktreeMounts(worktree, gitDir),
        forwardEnv: forwardNames,
        command,
      }),
    ],
    processEnv,
  };
};

/**
 * Run one headless session to completion. ALWAYS bounded by a wall-clock timeout and killed on expiry —
 * a stalled session must never hold a board claim forever.
 */
export const runSession = async (opts: SessionOptions): Promise<SessionResult> => {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const readOnly = opts.role === "review";
  if (readOnly && !RUNNER_CAPABILITIES[opts.plan.runner].enforcesReadOnly)
    log(
      `  ⚠ ${opts.plan.runner} has no verified tool allow-list flag — the rubric grader is NOT tool-constrained. ` +
        'Use --sandbox, or set runners.review.runner = "claude" for an enforced read-only grader.',
    );

  const command = buildRunnerArgs({
    runner: opts.plan.runner,
    role: opts.role,
    prompt: opts.prompt,
    cwd: opts.cwd,
    model: opts.plan.model,
    effort: opts.plan.effort,
    allowedTools: opts.allowedTools,
    readOnly,
    bypassPermissions: opts.bypassPermissions,
    outputSchemaPath: opts.outputSchemaPath,
  });

  let argv = command;
  let spawnEnv = scrubbedEnv(env);
  if (opts.sandbox) {
    const s = await sandboxCommand(opts.cwd, command, env);
    argv = s.argv;
    spawnEnv = s.processEnv;
    log(
      `  🔒 [sandbox] ${opts.role} session in ${SANDBOX_IMAGE} (network ${SANDBOX_NETWORK}, worktree-only mount)`,
    );
  }

  const [cmd, ...rest] = argv;
  // `unref` so a pending tick can never hold the process open past the session it was measuring.
  const ticker = opts.onHeartbeat
    ? setInterval(opts.onHeartbeat, SESSION_HEARTBEAT_MS).unref?.() ??
      setInterval(opts.onHeartbeat, SESSION_HEARTBEAT_MS)
    : undefined;
  try {
    const { stdout, stderr, exitCode, timedOut } = await run(cmd!, rest, {
      cwd: opts.cwd,
      env: spawnEnv,
      timeoutMs: opts.timeoutMs,
    });
    const parsed = parseRunnerOutput(opts.plan.runner, { stdout, exitCode });
    return { ...parsed, stderr, timedOut };
  } finally {
    if (ticker) clearInterval(ticker as unknown as ReturnType<typeof setInterval>);
  }
};
