/**
 * Pure release policy: conventional-commit parsing, semver tag selection, bump suggestion, and the
 * markdown notes render. The issue→version mapping is always DERIVED (commits between tags → PRs →
 * closed issues), never stored on the board — repo state is the source of truth. Everything impure
 * (git, gh, fs) lives in the CLI.
 */

export type CommitEntry = {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
  /** PR number from the squash-title suffix `(#123)`, if present. */
  pr: number | null;
  /** The raw subject, kept so unparseable commits can still appear verbatim. */
  subject: string;
};

const SUBJECT_RE = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s+(?<desc>.+)$/;
const PR_SUFFIX_RE = /\s*\(#(?<pr>\d+)\)\s*$/;

/** Parse one commit subject. Null when it isn't conventional (merge commits, freeform). */
export const parseCommitSubject = (subject: string): CommitEntry | null => {
  const trimmed = subject.trim();
  const prMatch = PR_SUFFIX_RE.exec(trimmed);
  const pr = prMatch?.groups?.pr ? Number(prMatch.groups.pr) : null;
  const withoutPr = prMatch ? trimmed.slice(0, prMatch.index).trim() : trimmed;
  const m = SUBJECT_RE.exec(withoutPr);
  if (!m?.groups) return null;
  return {
    type: m.groups.type!,
    scope: m.groups.scope?.trim() || null,
    breaking: m.groups.bang === "!",
    description: m.groups.desc!.trim(),
    pr,
    subject: trimmed,
  };
};

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

const semverOf = (tag: string): [number, number, number] | null => {
  const m = SEMVER_RE.exec(tag.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

const semverGt = (a: [number, number, number], b: [number, number, number]): boolean =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

/** Highest plain-semver tag (`v1.2.3` / `1.2.3`); pre-release/build tags and non-semver ignored. */
export const latestSemverTag = (tags: string[]): string | null => {
  let best: string | null = null;
  let bestV: [number, number, number] | null = null;
  for (const t of tags) {
    const v = semverOf(t);
    if (v && (!bestV || semverGt(v, bestV))) {
      best = t.trim();
      bestV = v;
    }
  }
  return best;
};

export type BumpSuggestion = { level: "major" | "minor" | "patch"; next: string };

/**
 * Suggested next version from the commits since `prevTag`. breaking→major, feat→minor, else patch —
 * except pre-1.0, where breaking→minor per semver custom (0.x majors are reserved for the 1.0 cut).
 * No previous tag → v0.1.0.
 */
export const suggestBump = (entries: CommitEntry[], prevTag: string | null): BumpSuggestion => {
  if (!prevTag || !semverOf(prevTag)) return { level: "minor", next: "v0.1.0" };
  const [maj, min, pat] = semverOf(prevTag)!;
  const breaking = entries.some((e) => e.breaking);
  const feat = entries.some((e) => e.type === "feat");
  const level: BumpSuggestion["level"] =
    breaking && maj >= 1 ? "major" : breaking || feat ? "minor" : "patch";
  const next =
    level === "major"
      ? `v${maj + 1}.0.0`
      : level === "minor"
        ? `v${maj}.${min + 1}.0`
        : `v${maj}.${min}.${pat + 1}`;
  return { level, next };
};

/** Section order for the notes. Anything not listed lands in Other. */
const SECTIONS: [title: string, types: string[]][] = [
  ["Breaking", []], // filled by the `breaking` flag, not a type
  ["Features", ["feat"]],
  ["Fixes", ["fix", "hotfix"]],
  ["Performance", ["perf"]],
  ["Refactoring", ["refactor"]],
  ["Docs", ["docs"]],
  ["Tests", ["test"]],
  ["Build", ["build", "ci"]],
  ["Chore", ["chore", "style", "revert"]],
];

export type NotesLine = { entry: CommitEntry; issues: number[] };
export type Section = { title: string; lines: NotesLine[] };

/** Group parsed entries (with their closed issues) into ordered sections; empty sections dropped. */
export const groupSections = (lines: NotesLine[]): Section[] => {
  const out: Section[] = [];
  const used = new Set<NotesLine>();
  const take = (pred: (l: NotesLine) => boolean): NotesLine[] =>
    lines.filter((l) => !used.has(l) && pred(l) && (used.add(l), true));
  for (const [title, types] of SECTIONS) {
    const got =
      title === "Breaking"
        ? take((l) => l.entry.breaking)
        : take((l) => types.includes(l.entry.type));
    if (got.length) out.push({ title, lines: got });
  }
  const rest = lines.filter((l) => !used.has(l));
  if (rest.length) out.push({ title: "Other", lines: rest });
  return out;
};

const renderLine = (l: NotesLine): string => {
  const refs: string[] = [];
  if (l.entry.pr !== null) refs.push(`#${l.entry.pr}`);
  if (l.issues.length) refs.push(`closes ${l.issues.map((n) => `#${n}`).join(", ")}`);
  const scope = l.entry.scope ? `**${l.entry.scope}**: ` : "";
  return `- ${scope}${l.entry.description}${refs.length ? ` (${refs.join("; ")})` : ""}`;
};

export type NotesInput = {
  tag: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  sections: Section[];
  /** e.g. https://github.com/o/r/compare/v0.1.0...v0.2.0 */
  compareUrl?: string | null;
};

/** Markdown release notes. Unparseable subjects should be passed in as `Other` lines by the caller. */
export const renderNotes = (input: NotesInput): string => {
  const out: string[] = [`## ${input.tag} — ${input.date}`, ""];
  for (const s of input.sections) {
    out.push(`### ${s.title}`, "");
    for (const l of s.lines) out.push(renderLine(l));
    out.push("");
  }
  if (!input.sections.length) out.push("_No changes derived — empty range._", "");
  if (input.compareUrl) out.push(`[Full diff](${input.compareUrl})`, "");
  return `${out.join("\n").trimEnd()}\n`;
};

/** New CHANGELOG.md text with `section` prepended under the standing header. Pure; fs is the caller's. */
export const prependChangelog = (existing: string | null, section: string): string => {
  const body = section.trimEnd();
  if (!existing || !existing.trim()) return `# Changelog\n\n${body}\n`;
  const lines = existing.split("\n");
  // Insert after a leading `# ...` header (plus its trailing blank lines); else prepend outright.
  if (lines[0]?.startsWith("# ")) {
    let i = 1;
    while (i < lines.length && lines[i]!.trim() === "") i++;
    return `${lines.slice(0, i).join("\n")}\n${body}\n\n${lines.slice(i).join("\n")}`;
  }
  return `${body}\n\n${existing}`;
};
