/**
 * Help text, generated from FLAG_SPECS + COMMAND_DOCS so it cannot drift from what parseArgs accepts.
 * Written for agents as much as humans: every command documents its flags, exit codes, and the exact
 * shape of its `--json` output.
 */
import { COMMANDS, type Command, FLAG_SPECS } from "./args.ts";

type CommandDoc = {
  summary: string;
  description: string[];
  usage: string;
  /** `--json` stdout shape, shown verbatim. */
  json: string;
  exitCodes: [string, string][];
  examples?: string[];
};

export const COMMAND_DOCS: Record<Command, CommandDoc> = {
  init: {
    summary: "verify prerequisites, provision the board + labels, write hamsterwheel.toml",
    usage: "hamster init [--yes | --dry-run] [--project-title <title>] [--json]",
    description: [
      "First-run setup. Idempotent, and every mutation is printed before it is made. Prompts y/N per",
      "mutation on a TTY; non-interactively (agents, CI, --json) you MUST pass --yes to apply or",
      "--dry-run to preview — init refuses to prompt when stdin is not a TTY.",
      "Provisions: the Projects v2 board (Status/Owner/Blocked reason fields), the loop:* and",
      "priority/size labels, hamsterwheel.toml, and the issue-contract block in CLAUDE.md/AGENTS.md.",
    ],
    json: `{ ok, command: "init", checks: [{name, status, detail}], repo, project: {number, title},
  labelsCreated: [name], config: {path, action}, agentDocs: [{file, action}] }`,
    exitCodes: [
      ["0", "setup complete (or dry run printed)"],
      ["1", "a blocking prerequisite failed, or non-interactive without --yes/--dry-run"],
    ],
    examples: [
      "hamster init --dry-run",
      'hamster init --yes --project-title "backend Loop" --json',
    ],
  },
  doctor: {
    summary: "re-run just the prerequisite checks",
    usage: "hamster doctor [--json]",
    description: [
      "Checks git, gh auth (+ the `project` scope), docker, the agent runner binaries, the config file,",
      "and that the configured project board exists. `warn` means a mode is unavailable; `fail` means",
      "the loop cannot run at all.",
    ],
    json: `{ ok, command: "doctor", checks: [{name, status: "ok"|"warn"|"fail", detail}],
  failed: n, warned: n }`,
    exitCodes: [
      ["0", "ready (warnings allowed)"],
      ["1", "at least one blocking failure"],
    ],
  },
  plan: {
    summary: "read-only: the eligible queue, skip reasons, and the resolved runner/model/effort",
    usage: "hamster plan [--config <path>] [--json]",
    description: [
      "Never mutates anything. Shows the queue in work order (priority → size → age), why each",
      "non-eligible issue was skipped, and the runner/model/effort each issue would get (with the",
      "source of each choice: label, config, heuristic, or runner default).",
    ],
    json: `{ ok, command: "plan", eligible: [{number, title, priority, size,
  implement: {runner, model, effort, ...sources}, review: {...}}], skipped: [{num, why}], pick }`,
    exitCodes: [
      ["0", "printed (an empty queue is not an error)"],
      ["1", "config/board unreachable"],
    ],
  },
  once: {
    summary: "one issue end to end (claim → PR → gate → merge / Blocked)",
    usage: "hamster once [--execute] [--issue <n>] [--pr-only] [--sandbox] [--bypass] [--json]",
    description: [
      "Works exactly one issue: claim it on the board, spawn the implement session, wait for CI, run",
      "the review + rubric gate, then merge or park it Blocked with a reason. Without --execute it is a",
      "dry pass: selection and planning only, nothing on the board or repo changes.",
      "--pr-only stops after the PR opens (no gate/merge) for supervised runs. --sandbox runs the",
      "sessions OS-isolated in docker. --bypass (claude only) lifts the scoped tool allow-list.",
    ],
    json: `{ ok, command: "once", execute, events: [{event, ...}], summary: {claimed, prsOpened,
  merged, done, blocked, failed} }  — events mirror the ~/.hamsterwheel/runs/*.jsonl run log`,
    exitCodes: [
      ["0", "the issue reached a terminal state (merged, Done, Blocked-with-reason, or dry pass)"],
      ["1", "run-fatal precondition (claim released, queue untouched) or unexpected error"],
    ],
    examples: ["hamster once --execute --issue 42 --pr-only", "hamster once --execute --json"],
  },
  run: {
    summary: "loop `once` until the Ready queue is empty (serial)",
    usage: "hamster run --execute [--issue <n>] [--pr-only] [--sandbox] [--bypass] [--json]",
    description: [
      "Serial by construction: one issue start→merge→next, one attempt per issue per invocation,",
      "bounded by max_iterations. Requires --execute — use `once` for a single dry pass, `plan` to",
      "inspect. A run-fatal error (bad credentials, missing binary, broken board) aborts the whole run",
      "with the claim rolled back; it never burns the queue into Blocked.",
    ],
    json: `{ ok, command: "run", execute, events: [{event, ...}], summary: {claimed, prsOpened,
  merged, done, blocked, failed} }  — events mirror the ~/.hamsterwheel/runs/*.jsonl run log`,
    exitCodes: [
      ["0", "queue drained (or hit max_iterations)"],
      ["1", "missing --execute, run-fatal abort, or unexpected error"],
    ],
    examples: ["hamster run --execute --sandbox --json"],
  },
  triage: {
    summary: "PM doctor + the auto-block passes (missing criteria, suspected injection)",
    usage: "hamster triage [--sync] [--execute] [--config <path>] [--json]",
    description: [
      "Reports what needs human attention: open issues not on the board, Drafts missing priority/size,",
      "Ready issues missing acceptance criteria or flagged by the injection tripwires, Ready epics,",
      "and everything Blocked. Read-only by default.",
      "--sync adds the missing open issues to the board as Draft. --execute applies the auto-block",
      "passes (criteria-less or injection-flagged Ready issues → Blocked with a comment).",
    ],
    json: `{ ok, command: "triage", board: {total, internal}, missing: [{repo, number, url}], synced,
  draftNeedsPriority: [n], draftNeedsSize: [n], readyNeedsCriteria: [n], readyInjectionFlagged: [n],
  readyEpics: [n], blocked: [n], eligible, next, autoBlocked: [{issue, reason}] }`,
    exitCodes: [
      ["0", "report printed (findings are not errors)"],
      ["1", "config/board unreachable"],
    ],
  },
  reconcile: {
    summary: "report in-flight items with no live session behind them",
    usage: "hamster reconcile [--config <path>] [--json]",
    description: [
      "Lists everything In Progress / In Review so a human can verify a live run actually owns it",
      "(the Owner field), and reset stale claims to Ready. Read-only: reconciliation decisions after a",
      "crashed driver are a human's to make.",
    ],
    json: `{ ok, command: "reconcile", inflight: [{number, status, owner}] }`,
    exitCodes: [
      ["0", "printed (in-flight items are not errors)"],
      ["1", "config/board unreachable"],
    ],
  },
  status: {
    summary: "what the loop is doing right now, and whether it is still alive",
    usage: "hamster status [--config <path>] [--json]",
    description: [
      "Reads the running loop's status file for this repo and reports the phase each lane is in, the",
      "issue it holds, the outcome counts so far, and how long since the last heartbeat.",
      "",
      "This exists because the run log cannot answer it. The log is append-only history, so 'working'",
      "and 'hung' look identical during a long phase — an implement session can run for the whole",
      "session timeout without appending a line. The status file is heartbeated during those waits, so",
      "staleness is measurable rather than inferred.",
      "",
      "Read-only, and safe to poll: it touches no network and no board.",
    ],
    json: `{ ok, command: "status", state: "idle"|"running"|"stale"|"ended", staleSeconds,
  detail, status: { runId, pid, repo, startedAt, updatedAt, endedAt?, lanes: [{lane, issue,
  phase, since}], counts: {claimed, prsOpened, merged, blocked, failed, done} } }`,
    exitCodes: [
      ["0", "idle, running or ended cleanly"],
      ["1", "stale — no heartbeat within the threshold; the run died or a phase is wedged"],
    ],
    examples: ["hamster status --json | jq -r .state"],
  },
  prune: {
    summary: "classify and clean up stale local WIP salvage branches",
    usage: "hamster prune [--delete] [--config <path>] [--json]",
    description: [
      "Sweeps local `<prefix>/<n>-wip-<runid>` salvage branches. Conservative by construction: a branch",
      "is deleted ONLY when its issue is affirmatively closed AND it is confirmed not the head of an",
      "open PR — a failed lookup keeps the branch. Default is a dry-run plan; --delete applies it.",
      "Deletions log the `(was <sha>)` handle so a wrong delete is recoverable.",
    ],
    json: `{ ok, command: "prune", dryRun, decisions: [{branch, issueNumber, action: "prune"|"keep",
  reason}], deleted: [{branch, ok, was?, error?}] }`,
    exitCodes: [
      ["0", "plan printed / deletions done"],
      ["1", "config unreachable or a deletion failed"],
    ],
  },
  release: {
    summary: "cut a version: derived notes, tag + GitHub Release, archive the shipped Done items",
    usage:
      "hamster release [--tag <v>] [--execute] [--changelog] [--archive-done] [--config <path>] [--json]",
    description: [
      "The one deliberately human-invoked mutation. The issue→version mapping is DERIVED, never stored:",
      "commits since the last semver tag → PRs (squash-title suffix) → the issues those PRs closed.",
      "Default is a preview: notes, suggested semver bump (when --tag is omitted), and the archive plan.",
      "--execute (requires --tag or --archive-done) creates the tag + GitHub Release pinned to the",
      'remote base tip, then archives exactly the shipped Done items — Done means "merged, not yet',
      'released". An item is archived only when its issue is affirmatively closed; a failed lookup',
      "keeps it. Archived items are restorable from the project's archive.",
      "--archive-done is the backfill arm: archive EVERY Done item whose issue is closed, no tag/notes.",
    ],
    json: `{ ok, command: "release", dryRun, tag, previousTag, suggested?: {level, next},
  prs: [{number, type, title, issues}], notes, archive: {planned: [{issue, itemId}],
  archived: [{issue, ok, error?}], kept: [{issue, reason}]}, release?: {url},
  changelog?: {path, action} }`,
    exitCodes: [
      ["0", "preview printed / release cut and archive done"],
      ["1", "usage (--execute without --tag/--archive-done), tag exists, or a mutation failed"],
    ],
    examples: [
      "hamster release",
      "hamster release --tag v0.5.0 --execute --changelog",
      "hamster release --archive-done --execute",
    ],
  },
};

const flagLines = (cmd: Command): string[] =>
  FLAG_SPECS.filter((s) => s.commands === "all" || s.commands.includes(cmd)).map((s) => {
    const head = [s.flag, s.alias].filter(Boolean).join(", ") + (s.arg ? ` ${s.arg}` : "");
    return `  ${head.padEnd(24)} ${s.desc}`;
  });

export const commandHelp = (cmd: Command, version: string): string => {
  const d = COMMAND_DOCS[cmd];
  return [
    `🐹 hamster ${cmd} (v${version}) — ${d.summary}`,
    "",
    "Usage:",
    `  ${d.usage}`,
    "",
    ...d.description.map((l) => `  ${l}`),
    "",
    "Flags:",
    ...flagLines(cmd),
    "  --help, -h               this help",
    "",
    "Exit codes:",
    ...d.exitCodes.map(([c, why]) => `  ${c}  ${why}`),
    "",
    "JSON output (--json, one object on stdout; logs go to stderr):",
    ...d.json.split("\n").map((l) => `  ${l}`),
    ...(d.examples ? ["", "Examples:", ...d.examples.map((e) => `  ${e}`)] : []),
  ].join("\n");
};

export const globalHelp = (version: string): string =>
  [
    `🐹 hamsterwheel v${version}`,
    "An autonomous issue loop for coding agents: you sleep, the hamster runs the wheel.",
    "",
    "Usage:",
    "  hamster <command> [flags]",
    "  hamster <command> --help    full flags, exit codes, and --json shape for that command",
    "",
    "Commands:",
    ...COMMANDS.map((c) => `  ${c.padEnd(10)} ${COMMAND_DOCS[c].summary}`),
    "",
    "Global flags:",
    "  --json                   one JSON object on stdout; human progress goes to stderr",
    "  --config <path>          use a specific hamsterwheel.toml (board-backed commands)",
    "  --help, -h               help (global, or per-command after a command name)",
    "  --version, -v            print the version",
    "",
    "Every command is non-interactive when its inputs are passed as flags; the only prompts are",
    "`init`'s y/N confirms, skipped with --yes or --dry-run.",
  ].join("\n");
