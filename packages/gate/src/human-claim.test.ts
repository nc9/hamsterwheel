// The community guard. These cases are the postmortem of a real incident: a contributor commented "I'd
// like to work on this", and twenty-two minutes later the loop claimed the same issue, opened a PR and
// merged it. Nothing in the selection path could see the comment.
import { describe, expect, test } from "bun:test";

import { type IssueComment, describeHumanClaim, detectHumanClaim } from "./select.ts";

const outsider = (author: string): IssueComment => ({ author, association: "NONE" });
const member = (author: string): IssueComment => ({ author, association: "MEMBER" });

describe("detectHumanClaim", () => {
  test("an untouched issue is the loop's to take", () => {
    expect(detectHumanClaim([], [])).toBeNull();
  });

  test("a comment from outside the org claims the issue", () => {
    expect(detectHumanClaim([], [outsider("volunteer")])).toEqual({
      kind: "comment",
      who: "volunteer",
    });
  });

  test("every in-org association is silent, so a private board is unaffected", () => {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"])
      expect(detectHumanClaim([], [{ author: "insider", association }])).toBeNull();
    // Case is not guaranteed by the API surface; matching must not depend on it.
    expect(detectHumanClaim([], [{ author: "insider", association: "member" }])).toBeNull();
  });

  test("CONTRIBUTOR is NOT in-org — a past contributor asking for another issue still counts", () => {
    expect(detectHumanClaim([], [{ author: "ex", association: "CONTRIBUTOR" }])?.kind).toBe(
      "comment",
    );
  });

  test("an assignee outranks everything, including when nobody commented", () => {
    expect(detectHumanClaim(["someone"], [])).toEqual({ kind: "assignee", who: "someone" });
  });

  test("bots are not people: neither an app assignee nor an app comment claims anything", () => {
    expect(detectHumanClaim(["dependabot[bot]"], [outsider("github-actions[bot]")])).toBeNull();
    expect(detectHumanClaim([], [outsider("app/renovate")])).toBeNull();
  });

  test("a bot comment does not mask a real one behind it", () => {
    expect(detectHumanClaim([], [outsider("ci[bot]"), outsider("human")])?.who).toBe("human");
  });

  test("the loop's own claim comments never trip it — they are posted in-org", () => {
    expect(detectHumanClaim([], [member("maintainer"), member("maintainer")])).toBeNull();
  });

  test("the hands-off label blocks regardless of who has or has not commented", () => {
    expect(detectHumanClaim([], [], ["loop:hands-off"], "loop:hands-off")).toEqual({
      kind: "label",
      who: "loop:hands-off",
    });
    // Label matching is case-insensitive: GitHub preserves the case a label was created with.
    expect(detectHumanClaim([], [], ["Loop:Hands-Off"], "loop:hands-off")?.kind).toBe("label");
    expect(detectHumanClaim([], [], ["enhancement"], "loop:hands-off")).toBeNull();
  });

  test("no configured hands-off label means labels are not consulted at all", () => {
    expect(detectHumanClaim([], [], ["loop:hands-off"])).toBeNull();
  });
});

describe("describeHumanClaim", () => {
  test("each kind reads as a reason a human can act on", () => {
    expect(describeHumanClaim({ kind: "assignee", who: "a" })).toBe("assigned to @a");
    expect(describeHumanClaim({ kind: "comment", who: "b" })).toBe(
      "@b commented from outside the org",
    );
    expect(describeHumanClaim({ kind: "label", who: "loop:hands-off" })).toContain(
      "loop:hands-off",
    );
  });
});
