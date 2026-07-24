export type RubricVerdict = {
  pass: boolean;
  criteria: { text: string; met: boolean; evidence?: string }[];
};
// Parse the last COMPLETE top-level JSON object from a rubric session's output (scan back from the
// final `}`, brace-match to its `{`, retry earlier if it doesn't parse) — models wrap JSON in prose.
// pass = every criterion met.
export const parseRubricVerdict = (text: string): RubricVerdict => {
  let obj:
    | { pass?: boolean; criteria?: { text: string; met: boolean; evidence?: string }[] }
    | undefined;
  for (let end = text.lastIndexOf("}"); end !== -1 && !obj; end = text.lastIndexOf("}", end - 1)) {
    let depth = 0,
      start = -1;
    for (let i = end; i >= 0; i--) {
      if (text[i] === "}") depth++;
      else if (text[i] === "{" && --depth === 0) {
        start = i;
        break;
      }
    }
    if (start !== -1)
      try {
        obj = JSON.parse(text.slice(start, end + 1));
      } catch {
        /* try an earlier } */
      }
  }
  if (!obj) throw new Error("no JSON verdict in rubric output");
  const criteria = Array.isArray(obj.criteria) ? obj.criteria : [];
  const pass = criteria.length > 0 ? criteria.every((c) => c.met === true) : obj.pass === true;
  return { pass, criteria };
};

// An AC phrased as "tests pass" / "tsgo --noEmit clean" / "lint clean" is EXECUTION-dependent: a
// read-only grader (Read/Grep/Glob, no Bash) can't run it, so it defaults to unmet and false-fails
// correct PRs. The deterministic CI gate already owns these — the rubric only runs once CI is green —
// so re-judging them in the grader is redundant and guaranteed to false-fail.
// Match only a tooling/test token COUPLED with a pass/clean/green outcome (or the standalone --noEmit
// flag): a behavioral AC that merely mentions "tsgo"/"tests" (e.g. "…cannot execute tsgo/tests" or
// "the report's date format is ISO 8601") must NOT match — a false positive credits an unverified
// criterion, so err toward NOT filtering (a miss just leaves the status quo: grader judges it).
const ED_TOOL =
  "tsgo|type[\\s-]?check(?:s|ing|ed)?|tests?|test\\s+suite|bun\\s+(?:run\\s+)?test|npm\\s+test|lint(?:s|ing|er)?|oxlint|oxfmt|format(?:ting)?|builds?|compiles?|compiling|ci";
const ED_PASS = "pass(?:es|ing|ed)?|clean|green|succeed(?:s|ed|ing)?";
export const EXECUTION_DEPENDENT_RE = new RegExp(
  `--no-?emit|\\b(?:${ED_TOOL})\\b[^.\\n]{0,20}\\b(?:${ED_PASS})\\b|\\b(?:${ED_PASS})\\b[^.\\n]{0,20}\\b(?:${ED_TOOL})\\b`,
  "i",
);
export const isExecutionDependent = (text: string): boolean => EXECUTION_DEPENDENT_RE.test(text);

// Reconcile the grader verdict with the deterministic CI gate: once CI is green, an execution-dependent
// criterion the grader marked unmet (it can't run tsgo/tests) is credited as met — CI verified it.
// Behavioral criteria are untouched, so codebase-aware grading still owns substance.
export const applyCiToRubric = (v: RubricVerdict, ciGreen: boolean): RubricVerdict => {
  if (!ciGreen) return v;
  const criteria = v.criteria.map((c) =>
    !c.met && isExecutionDependent(c.text)
      ? {
          ...c,
          met: true,
          evidence: `CI green — deterministic gate owns this (grader can't execute)${c.evidence ? `; grader noted: ${c.evidence}` : ""}`,
        }
      : c,
  );
  const pass = criteria.length > 0 ? criteria.every((c) => c.met === true) : v.pass;
  return { pass, criteria };
};
