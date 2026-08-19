import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import type { Clock } from "./runlog.ts";

/**
 * Live status for a running loop, so a supervising agent can answer "is it working, where is it, is
 * it stuck" without tailing and reconstructing the run log.
 *
 * The run log is append-only history: excellent for post-mortems, useless for "what is happening
 * right now". Reconstructing current state from it means replaying every line and knowing which
 * events supersede which — and it still cannot distinguish a live session from a dead process,
 * because a killed run simply stops appending. Between `implement-session` and `pr-open` there can
 * be a full `session_timeout_ms` of silence, and silence is exactly what a hang looks like.
 *
 * This file answers both questions from ONE known path:
 *   - what phase, which issue, which lane, how many of each outcome so far;
 *   - `updatedAt`, refreshed on a heartbeat during long waits, so `now - updatedAt` is staleness.
 *
 * Written atomically (write temp, rename) because the reader is a different process polling on its
 * own schedule: a torn half-written JSON file read at the wrong moment is worse than stale data.
 */

/** Coarse phase of one lane's pipeline. Ordered as the pipeline runs them. */
export type Phase =
  | "idle"
  | "claiming"
  | "implementing"
  | "ci-wait"
  | "review-fix"
  | "rubric"
  | "merging"
  | "done";

export type LaneStatus = {
  lane: number;
  issue: number | null;
  phase: Phase;
  /** ISO time this lane entered `phase` — a phase that has not advanced in an hour is the signal. */
  since: string;
  detail?: string;
};

export type LoopStatus = {
  runId: string;
  pid: number;
  repo: string;
  command: string;
  execute: boolean;
  startedAt: string;
  /** Refreshed on every event AND on the poll heartbeat. Staleness is measured from here. */
  updatedAt: string;
  /** Set when the run ends, so a finished run is distinguishable from one that died mid-flight. */
  endedAt?: string;
  lanes: LaneStatus[];
  counts: {
    claimed: number;
    prsOpened: number;
    merged: number;
    blocked: number;
    failed: number;
    done: number;
  };
};

export type StatusWriter = {
  path: string;
  /** Move one lane to a new phase. Also refreshes `updatedAt`. */
  phase: (lane: number, phase: Phase, extra?: { issue?: number | null; detail?: string }) => void;
  /** Refresh `updatedAt` without changing anything else — call from inside long polls. */
  heartbeat: () => void;
  /** Bump an outcome counter. */
  count: (key: keyof LoopStatus["counts"]) => void;
  /** Mark the run finished. The file is kept: "ended cleanly 20m ago" is useful to a reader. */
  finish: () => void;
};

/** A no-op writer for read-only commands, which must not leave a status file behind. */
export const nullStatus = (): StatusWriter => ({
  path: "",
  phase: () => {},
  heartbeat: () => {},
  count: () => {},
  finish: () => {},
});

export const STATUS_FILENAME = "current.json";

export const createStatus = (opts: {
  /** Repo-scoped run directory — see runDirFor. */
  dir: string;
  runId: string;
  repo: string;
  command: string;
  execute: boolean;
  lanes: number;
  now?: Clock;
  pid?: number;
}): StatusWriter => {
  const now = opts.now ?? (() => new Date());
  const path = `${opts.dir}/${STATUS_FILENAME}`;
  const started = now().toISOString();

  const state: LoopStatus = {
    runId: opts.runId,
    pid: opts.pid ?? process.pid,
    repo: opts.repo,
    command: opts.command,
    execute: opts.execute,
    startedAt: started,
    updatedAt: started,
    lanes: Array.from({ length: Math.max(1, opts.lanes) }, (_, lane) => ({
      lane,
      issue: null,
      phase: "idle" as Phase,
      since: started,
    })),
    counts: { claimed: 0, prsOpened: 0, merged: 0, blocked: 0, failed: 0, done: 0 },
  };

  // Best-effort by construction, exactly like the run log: observability is never worth failing a
  // live run over. A status file that cannot be written is a monitoring problem, not a loop problem.
  const flush = (): void => {
    try {
      const tmp = `${path}.${state.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(tmp, path);
    } catch {
      /* ignore */
    }
  };

  flush();

  return {
    path,
    phase: (lane, phase, extra) => {
      const ts = now().toISOString();
      state.updatedAt = ts;
      const entry = state.lanes.find((l) => l.lane === lane);
      if (entry) {
        // `since` tracks phase ENTRY, not the last touch — a heartbeat must not reset it, or a
        // wedged phase would look freshly entered forever.
        if (entry.phase !== phase) entry.since = ts;
        entry.phase = phase;
        if (extra && "issue" in extra) entry.issue = extra.issue ?? null;
        entry.detail = extra?.detail;
      }
      flush();
    },
    heartbeat: () => {
      state.updatedAt = now().toISOString();
      flush();
    },
    count: (key) => {
      state.counts[key] += 1;
      state.updatedAt = now().toISOString();
      flush();
    },
    finish: () => {
      const ts = now().toISOString();
      state.updatedAt = ts;
      state.endedAt = ts;
      for (const l of state.lanes) {
        l.phase = "done";
        l.issue = null;
      }
      flush();
    },
  };
};

/**
 * Per-repo run directory. Previously every run of every repo landed in one flat directory, so
 * finding "the current run" meant `ls -t | head -1` — which silently returns another repo's run the
 * moment two loops exist, and the run log carried no `repo` field to catch the mistake.
 */
export const runDirFor = (home: string, repo: string): string =>
  `${home}/.hamsterwheel/runs/${repo.replace("/", "-")}`;

export type StatusVerdict = {
  state: "idle" | "running" | "stale" | "ended";
  /** Seconds since `updatedAt`, or null when there is no status file at all. */
  staleSeconds: number | null;
  status: LoopStatus | null;
  detail: string;
};

/**
 * Classify a status file. Pure so the thresholds are testable without a live run.
 *
 * `staleAfterSeconds` should exceed the heartbeat interval by a comfortable margin — the poll that
 * refreshes it runs on the CI wait's own cadence, so a single slow tick must not read as death.
 */
export const classifyStatus = (
  status: LoopStatus | null,
  nowMs: number,
  staleAfterSeconds = 180,
): StatusVerdict => {
  if (!status)
    return { state: "idle", staleSeconds: null, status: null, detail: "no run has been recorded" };

  const updated = Date.parse(status.updatedAt);
  const staleSeconds = Number.isNaN(updated) ? null : Math.max(0, (nowMs - updated) / 1000);

  if (status.endedAt)
    return {
      state: "ended",
      staleSeconds,
      status,
      detail: `run ${status.runId} finished at ${status.endedAt}`,
    };

  if (staleSeconds === null || staleSeconds > staleAfterSeconds)
    return {
      state: "stale",
      staleSeconds,
      status,
      // Deliberately not "dead": the process may be alive and wedged, which needs a different fix
      // from a crash. Both want a human, and the file cannot tell them apart on its own.
      detail: `no heartbeat for ${staleSeconds === null ? "an unknown time" : `${Math.round(staleSeconds)}s`} — the run died, or a phase is wedged (pid ${status.pid})`,
    };

  const active = status.lanes.filter((l) => l.phase !== "idle" && l.phase !== "done");
  return {
    state: "running",
    staleSeconds,
    status,
    detail: active.length
      ? active.map((l) => `lane-${l.lane}: #${l.issue ?? "?"} ${l.phase}`).join(" · ")
      : "no lane is currently working an issue",
  };
};

/**
 * Read a repo's status file, or null when there is none / it is unreadable. Never throws: a missing
 * or corrupt status file means "I cannot tell", which the caller renders as idle rather than
 * crashing a monitoring command.
 */
export const readStatus = (dir: string): LoopStatus | null => {
  try {
    const raw = readFileSync(`${dir}/${STATUS_FILENAME}`, "utf8");
    const parsed = JSON.parse(raw) as LoopStatus;
    return parsed && typeof parsed.runId === "string" ? parsed : null;
  } catch {
    return null;
  }
};

/** Remove a status file. Used by `prune`-style cleanup; never called on a live run. */
export const clearStatus = (dir: string): void => {
  try {
    rmSync(`${dir}/${STATUS_FILENAME}`, { force: true });
  } catch {
    /* ignore */
  }
};
