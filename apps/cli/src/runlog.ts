import { appendFileSync, mkdirSync } from "node:fs";

/**
 * Structured run log: `~/.hamsterwheel/runs/<ts>.jsonl`, one JSON object per line. The issue comment
 * timeline is the human-readable audit log; this is the machine-readable one (what was claimed, which
 * runner/model ran, every gate signal, why a merge was refused).
 *
 * The clock is INJECTED so the log is deterministic under test — no `Date.now()` inside anything the
 * tests need to assert on.
 */
export type Clock = () => Date;

export type RunLog = {
  path: string;
  runId: string;
  append: (event: string, data?: Record<string, unknown>) => void;
};

/** Best-effort by construction: a failed write must never take down a live implement session. */
export const createRunLog = (opts: { dir: string; runId: string; now?: Clock }): RunLog => {
  const now = opts.now ?? (() => new Date());
  const stamp = now().toISOString().replaceAll(/[:.]/g, "-");
  const path = `${opts.dir}/${stamp}.jsonl`;
  try {
    mkdirSync(opts.dir, { recursive: true });
  } catch {
    /* logged below on the first append attempt */
  }
  return {
    path,
    runId: opts.runId,
    append(event, data = {}) {
      const line = JSON.stringify({ ts: now().toISOString(), run: opts.runId, event, ...data });
      try {
        appendFileSync(path, `${line}\n`);
      } catch {
        /* observability is never worth failing a run over */
      }
    },
  };
};

/** A no-op sink for read-only commands (`plan`, `doctor`) that shouldn't leave a run file behind. */
export const nullRunLog = (runId = "read-only"): RunLog => ({ path: "", runId, append: () => {} });

/** Run id: sortable, collision-free within a millisecond, and safe in a git ref. */
export const makeRunId = (issue: number, now: Clock = () => new Date()): string =>
  `loop-${now().getTime().toString(36)}-${issue}`;
