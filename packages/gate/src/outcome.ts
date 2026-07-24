// An implement session ends one of four ways: a real PR (last line is a PR url) → gate it; `resolved` —
// the agent explicitly signalled the work is already in main, on a clean empty session → Done;
// `maybe-resolved` — a clean empty session with no signal → CANDIDATE "already in main" that the caller
// must corroborate (a prior merged PR that closes it) before Done, else Block — a clean no-op can also be
// a silent give-up/refusal; `fail` — a dirty tree, a non-zero exit, or a signal that contradicts the
// session state (token printed but edits made / crashed) — a real failure → Block.
export type ImplementOutcome =
  | { kind: "pr"; url: string }
  | { kind: "resolved"; via: "agent-signal" }
  | { kind: "maybe-resolved" }
  | { kind: "fail" };

export const PR_URL_RE = /github\.com\/.+\/pull\/\d+/;
// The agent prints exactly this (alone, on the last line) when it determines the issue needs no code
// changes. End-anchored: a verbose "ALREADY-RESOLVED but I couldn't verify…" line falls through to the
// corroborated maybe-resolved path rather than being trusted outright.
export const RESOLVED_SIGNAL_RE =
  /^\s*(?:ALREADY[-\s_]RESOLVED|NO[-\s_]CHANGES[-\s_]NEEDED)\s*\.?\s*$/i;

export const classifyImplement = (o: {
  lastLine: string;
  exitCode: number;
  hasChanges: boolean;
}): ImplementOutcome => {
  if (PR_URL_RE.test(o.lastLine)) return { kind: "pr", url: o.lastLine };
  const cleanNoOp = o.exitCode === 0 && !o.hasChanges; // session ended cleanly and left main untouched
  // Trust the explicit signal only on a clean no-op; a token over edits or a crash is contradictory → fail.
  if (RESOLVED_SIGNAL_RE.test(o.lastLine))
    return cleanNoOp ? { kind: "resolved", via: "agent-signal" } : { kind: "fail" };
  // No PR, no signal, but a clean no-op tree: candidate already-in-main — the caller confirms via a prior PR.
  if (cleanNoOp) return { kind: "maybe-resolved" };
  return { kind: "fail" };
};
