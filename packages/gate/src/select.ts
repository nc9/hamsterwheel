// Queue selection: the pure half of "which issue does the loop pick next". Everything here reads only
// the issue's own text and labels, so the whole ordering is unit-testable without touching GitHub.

export const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
export const SIZE_RANK: Record<string, number> = { XS: 0, S: 1, M: 2, L: 3, XL: 4 };
/** Unsized issues sort as if L — an unsized item must not jump ahead of a sized small win. */
export const UNKNOWN_SIZE_RANK = 3;
/** Unprioritized issues sort last; 9 is deliberately far past P3 so any real priority beats it. */
export const UNKNOWN_PRIORITY_RANK = 9;

/** The subset of an enriched issue the pure selection/policy helpers need. */
export type SelectableIssue = {
  number: number;
  title: string;
  labels: string[];
  createdAt: string;
  priority: number;
  size: number;
};

/** Rank from a `P0`–`P3` label, else UNKNOWN_PRIORITY_RANK. */
export const priorityRank = (labels: string[]): number => {
  const l = labels.find((x) => /^P[0-3]$/.test(x));
  return l ? PRIORITY_RANK[l]! : UNKNOWN_PRIORITY_RANK;
};

/** Rank from a `size: M`-style label, else UNKNOWN_SIZE_RANK. */
export const sizeRank = (labels: string[]): number => {
  const raw = labels
    .find((x) => x.toLowerCase().startsWith("size:"))
    ?.slice("size:".length)
    .trim();
  const rank = raw ? SIZE_RANK[raw.toUpperCase()] : undefined;
  return rank ?? UNKNOWN_SIZE_RANK;
};

// Queue order: priority (P0→P3) → size (XS→XL) → age (oldest first). ISO-8601 createdAt sorts
// lexicographically, so no Date parsing (and no clock) is involved.
export const compareIssues = (a: SelectableIssue, b: SelectableIssue): number =>
  a.priority - b.priority || a.size - b.size || a.createdAt.localeCompare(b.createdAt);

/**
 * Dependency refs an issue declares. Only `Depends on #N` / `Blocked by #N` count — a bare `#N` in
 * prose is a cross-reference, not a dependency, and treating it as one would wedge the whole queue.
 */
export const parseDeps = (body: string): number[] => {
  const out = new Set<number>();
  for (const m of body.matchAll(/(?:depends on|blocked by)\s*:?\s*((?:#\d+[\s,]*)+)/gi))
    for (const r of m[1]!.matchAll(/#(\d+)/g)) out.add(Number(r[1]));
  return [...out];
};

/**
 * Does the body carry the acceptance-criteria contract? BOTH a `## <heading>` line and at least one
 * markdown checkbox — a heading with prose under it isn't a rubric, and the checklist IS the rubric the
 * merge gate grades against. Missing → the issue is blocked for a human, never worked.
 */
export const hasAcceptanceCriteria = (body: string, heading = "Acceptance Criteria"): boolean => {
  const escaped = heading.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`#{1,6}\\s*${escaped}`, "i").test(body) && /-\s*\[[ x]\]/.test(body);
};

/**
 * `epic(...)` / `epic: ...`-titled issues are containers — the loop works their sub-issues, never the
 * epic itself. Both spellings occur in real backlogs, and a container that slips through gets claimed
 * as an ordinary work item, so match the intent, not one house style.
 */
export const isEpicTitle = (title: string): boolean => /^epic\s*[:(]/i.test(title);
