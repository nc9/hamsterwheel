import { describe, expect, test } from "bun:test";

import {
  type NotesLine,
  groupSections,
  latestSemverTag,
  parseCommitSubject,
  prependChangelog,
  renderNotes,
  suggestBump,
} from "./release.ts";

const entry = (subject: string) => {
  const e = parseCommitSubject(subject);
  if (!e) throw new Error(`unparseable: ${subject}`);
  return e;
};
const line = (subject: string, issues: number[] = []): NotesLine => ({
  entry: entry(subject),
  issues,
});

describe("parseCommitSubject", () => {
  test("full conventional form with PR suffix", () => {
    expect(parseCommitSubject("feat(api): add rate limiting (#42)")).toEqual({
      type: "feat",
      scope: "api",
      breaking: false,
      description: "add rate limiting",
      pr: 42,
      subject: "feat(api): add rate limiting (#42)",
    });
  });

  test("no scope, no PR", () => {
    const e = entry("fix: resolve login loop");
    expect(e.scope).toBeNull();
    expect(e.pr).toBeNull();
    expect(e.type).toBe("fix");
  });

  test("breaking marker", () => {
    expect(entry("feat(db)!: drop legacy tables (#7)").breaking).toBe(true);
  });

  test("merge commits and freeform subjects are null", () => {
    expect(parseCommitSubject("Merge branch 'main' into feat/x")).toBeNull();
    expect(parseCommitSubject("update stuff")).toBeNull();
    expect(parseCommitSubject("Feat: capitalized type")).toBeNull();
  });

  test("an issue-looking suffix inside the description is not eaten mid-string", () => {
    const e = entry("fix(auth): resolve #123 race (#456)");
    expect(e.pr).toBe(456);
    expect(e.description).toBe("resolve #123 race");
  });
});

describe("latestSemverTag", () => {
  test("numeric ordering, not lexicographic — v10 > v9", () => {
    expect(latestSemverTag(["v9.0.0", "v10.0.0", "v1.2.3"])).toBe("v10.0.0");
  });
  test("ignores non-semver and pre-release tags", () => {
    expect(latestSemverTag(["nightly", "v1.0.0-rc.1", "v0.2.0", "release-3"])).toBe("v0.2.0");
  });
  test("no-v form accepted; empty → null", () => {
    expect(latestSemverTag(["0.3.1", "v0.3.0"])).toBe("0.3.1");
    expect(latestSemverTag([])).toBeNull();
  });
});

describe("suggestBump", () => {
  test("no previous tag → v0.1.0", () => {
    expect(suggestBump([entry("feat: x")], null)).toEqual({ level: "minor", next: "v0.1.0" });
  });
  test("feat → minor, fix-only → patch", () => {
    expect(suggestBump([entry("feat: x"), entry("fix: y")], "v1.2.3").next).toBe("v1.3.0");
    expect(suggestBump([entry("fix: y"), entry("chore: z")], "v1.2.3").next).toBe("v1.2.4");
  });
  test("breaking → major post-1.0, minor pre-1.0", () => {
    expect(suggestBump([entry("feat!: x")], "v1.2.3")).toEqual({ level: "major", next: "v2.0.0" });
    expect(suggestBump([entry("feat!: x")], "v0.4.2")).toEqual({ level: "minor", next: "v0.5.0" });
  });
});

describe("groupSections", () => {
  test("ordered sections, breaking first, unknown types in Other, empties dropped", () => {
    const sections = groupSections([
      line("chore(deps): bump bun"),
      line("feat(cli): add release (#9)", [3]),
      line("feat(db)!: drop legacy (#8)"),
      line("fix(auth): login loop (#7)", [2]),
      line("wip: odd type"),
    ]);
    expect(sections.map((s) => s.title)).toEqual(["Breaking", "Features", "Fixes", "Chore", "Other"]);
    expect(sections[0]!.lines[0]!.entry.type).toBe("feat");
    expect(sections[1]!.lines[0]!.issues).toEqual([3]);
  });
});

describe("renderNotes", () => {
  test("renders scope, PR and issue refs; compare link", () => {
    const md = renderNotes({
      tag: "v0.2.0",
      date: "2026-07-27",
      sections: groupSections([line("feat(cli): add release (#9)", [3, 4])]),
      compareUrl: "https://github.com/o/r/compare/v0.1.0...v0.2.0",
    });
    expect(md).toContain("## v0.2.0 — 2026-07-27");
    expect(md).toContain("- **cli**: add release (#9; closes #3, #4)");
    expect(md).toContain("[Full diff](https://github.com/o/r/compare/v0.1.0...v0.2.0)");
  });
  test("empty range says so", () => {
    expect(renderNotes({ tag: "v0.2.0", date: "2026-07-27", sections: [] })).toContain(
      "empty range",
    );
  });
});

describe("prependChangelog", () => {
  test("creates the file with a header when missing/empty", () => {
    expect(prependChangelog(null, "## v0.1.0 — d\n\n- x\n")).toBe(
      "# Changelog\n\n## v0.1.0 — d\n\n- x\n",
    );
  });
  test("inserts after an existing top header, newest first", () => {
    const existing = "# Changelog\n\n## v0.1.0 — d1\n\n- old\n";
    const out = prependChangelog(existing, "## v0.2.0 — d2\n\n- new\n");
    expect(out.indexOf("v0.2.0")).toBeLessThan(out.indexOf("v0.1.0"));
    expect(out.startsWith("# Changelog\n")).toBe(true);
  });
  test("no header → straight prepend", () => {
    const out = prependChangelog("## v0.1.0 — d\n", "## v0.2.0 — d\n");
    expect(out.startsWith("## v0.2.0")).toBe(true);
  });
});
