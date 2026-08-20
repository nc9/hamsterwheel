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
 * Refs may follow inline (`Depends on #12, #13`) or as the contract's markdown list
 * (`## Depends on` above `- #12` lines) — the list markers between the phrase and the refs must
 * parse too, or every dep declared in the documented format is silently ignored and the loop works
 * dependents before their dependency exists.
 */
export const parseDeps = (body: string): number[] => {
  const out = new Set<number>();
  for (const m of body.matchAll(/(?:depends on|blocked by)\s*:?\s*((?:[\s,*+-]*#\d+)+)/gi))
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

/** Associations GitHub reports for someone inside the org. Everyone else is an outside contributor. */
export const ORG_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** One comment, reduced to the two fields the guard reads. */
export type IssueComment = { author: string; association: string };

/** Why an issue is spoken for by a person. `who` is the login to name in the block reason. */
export type HumanClaim = { kind: "assignee" | "comment" | "label"; who: string };

/** GitHub App / Action identities comment as `something[bot]`; they are not people volunteering. */
const isBotLogin = (login: string): boolean => /\[bot\]$/i.test(login) || login.startsWith("app/");

/**
 * Is a person already working this issue, or asking to?
 *
 * The loop reads an issue's title, body and labels — which is to say it cannot see the two places a
 * human says "mine": the assignee field, and a comment. In a public repo the comment IS the signal,
 * because a drive-by contributor has no write access and so cannot self-assign. Missing it is how a
 * loop opened and merged a PR twenty-two minutes after someone volunteered for the same issue, having
 * posted a plan of attack that matched what the loop went on to ship.
 *
 * Deliberately blunt: ANY comment from outside the org counts, including a bare "+1". A false positive
 * costs a human a few seconds to wave the issue through; a false negative costs a contributor their
 * afternoon and the project a contributor. On a private board every commenter is a MEMBER, so the guard
 * is silent there and needs no repo-visibility check to stay out of the way.
 */
export const detectHumanClaim = (
  assignees: string[],
  comments: IssueComment[],
  labels: string[] = [],
  handsOffLabel?: string,
): HumanClaim | null => {
  if (handsOffLabel) {
    const hit = labels.find((l) => l.toLowerCase() === handsOffLabel.toLowerCase());
    if (hit) return { kind: "label", who: hit };
  }
  // An assignee is the strongest signal there is, whoever they are: someone with write access made a
  // deliberate statement about who owns this.
  const person = assignees.find((a) => !isBotLogin(a));
  if (person) return { kind: "assignee", who: person };
  const outside = comments.find(
    (c) => !ORG_ASSOCIATIONS.has(c.association.toUpperCase()) && !isBotLogin(c.author),
  );
  return outside ? { kind: "comment", who: outside.author } : null;
};

/** One line explaining a claim, for the skip list and the board's blocked reason. */
export const describeHumanClaim = (c: HumanClaim): string =>
  c.kind === "assignee"
    ? `assigned to @${c.who}`
    : c.kind === "label"
      ? `carries the \`${c.who}\` label`
      : `@${c.who} commented from outside the org`;
