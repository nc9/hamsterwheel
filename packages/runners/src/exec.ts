import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Runtime helpers written against NODE APIs, not Bun's.
 *
 * Bun implements the node standard library, so node-compatible source runs unchanged under both — while
 * bun's own spawn/which/shell helpers run only under bun. Since `@hamsterwheel/gate` and friends are
 * libraries other people import, being bun-only would push that constraint onto every consumer. One
 * implementation, both runtimes, no shim and no dual code paths.
 */

export type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when `timeoutMs` elapsed and the child was killed. A stalled session must never run forever. */
  timedOut: boolean;
};

/**
 * Run a command and capture it. Never throws on a non-zero exit — callers branch on `exitCode`, which is
 * what every call site here wants (this replaces bun's `$\`…\`.quiet().nothrow()`).
 *
 * argv is an ARRAY and there is no shell: `cmd` and each arg are passed as separate process arguments, so
 * a value containing spaces, quotes or `;` is data, never syntax. Do not "helpfully" add `shell: true`.
 */
export const run = (
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    /** Kill the child after this long. Omit for no limit. */
    timeoutMs?: number;
  } = {},
): Promise<RunResult> =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, opts.timeoutMs);
    const done = (r: Omit<RunResult, "timedOut">) => {
      if (timer) clearTimeout(timer);
      resolve({ ...r, timedOut });
    };
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    // A spawn error (ENOENT for a missing binary) resolves as a non-zero exit rather than rejecting, so
    // "the tool isn't installed" and "the tool failed" reach the caller through one path.
    child.on("error", (e) => done({ exitCode: 127, stdout, stderr: String(e) }));
    child.on("close", (code) => done({ exitCode: code ?? 1, stdout, stderr }));
    // stdin is ALWAYS closed. Left open as a pipe, any child that reads stdin (gh prompting, git asking
    // for credentials) blocks forever and takes the loop with it — a hang, not an error, so nothing times
    // out and nothing is logged.
    if (opts.input !== undefined) child.stdin?.write(opts.input);
    child.stdin?.end();
  });

/** `run` for git, which is always argv-shaped here. */
export const git = (args: string[], cwd?: string): Promise<RunResult> => run("git", args, { cwd });

/**
 * First executable named `bin` on PATH, or null. Node-portable replacement for bun's which helper.
 *
 * Windows is not handled (no PATHEXT probing) — hamsterwheel needs git, gh, docker and a POSIX-ish
 * worktree layout anyway, so a half-working Windows path would be worse than an honest absence.
 */
export const whichBin = (bin: string, env: NodeJS.ProcessEnv = process.env): string | null => {
  if (bin.includes("/")) return isExecutable(bin) ? bin : null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, bin);
    if (isExecutable(full)) return full;
  }
  return null;
};

const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Node-portable sleep (bun's global sleep helper is bun-only). */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
