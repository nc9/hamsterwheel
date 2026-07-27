/**
 * Argv parsing, kept pure so every flag combination is testable without running a command.
 *
 * FLAG_SPECS is the single source of truth: parsing, per-command applicability validation, and the
 * generated help (help.ts) all read it, so a flag cannot exist without being documented.
 */

export const COMMANDS = [
  "init",
  "doctor",
  "plan",
  "once",
  "run",
  "triage",
  "reconcile",
  "prune",
  "release",
] as const;
export type Command = (typeof COMMANDS)[number];

export const isCommand = (v: string): v is Command => (COMMANDS as readonly string[]).includes(v);

export type FlagSpec = {
  /** Canonical form, e.g. `--issue`. */
  flag: string;
  alias?: string;
  /** Placeholder for the value, e.g. `<n>` — absent for booleans. */
  arg?: string;
  desc: string;
  /** Which commands accept it. "all" = every command. */
  commands: readonly Command[] | "all";
};

export const FLAG_SPECS: readonly FlagSpec[] = [
  {
    flag: "--execute",
    desc: "do real work — without it the command is a read-only / print-only pass",
    commands: ["once", "run", "triage", "release"],
  },
  {
    flag: "--tag",
    arg: "<v>",
    desc: "version tag to cut, e.g. v0.5.0 (omit to preview with a suggested bump)",
    commands: ["release"],
  },
  {
    flag: "--changelog",
    desc: "also prepend the notes to CHANGELOG.md (the commit is left to you)",
    commands: ["release"],
  },
  {
    flag: "--archive-done",
    desc: "backfill: archive every Done item whose issue is closed — no tag, no notes",
    commands: ["release"],
  },
  {
    flag: "--issue",
    arg: "<n>",
    desc: "target a specific Ready+eligible issue instead of the head of the queue",
    commands: ["once", "run"],
  },
  {
    flag: "--pr-only",
    desc: "stop at the open PR: skip the merge gate (supervised runs)",
    commands: ["once", "run"],
  },
  {
    flag: "--sandbox",
    desc: "OS-isolate the sessions in a docker container",
    commands: ["once", "run"],
  },
  {
    flag: "--bypass",
    desc: "claude only: full bypassPermissions instead of the scoped allow-list (loud, supervised)",
    commands: ["once", "run"],
  },
  {
    flag: "--sync",
    desc: "add open issues missing from the board as Draft",
    commands: ["triage"],
  },
  {
    flag: "--delete",
    desc: "actually delete the prunable branches (default is a dry-run plan)",
    commands: ["prune"],
  },
  {
    flag: "--yes",
    alias: "-y",
    desc: "apply every proposed mutation without prompting (required for non-interactive use)",
    commands: ["init"],
  },
  {
    flag: "--dry-run",
    desc: "print every mutation init would make, write nothing",
    commands: ["init"],
  },
  {
    flag: "--project-title",
    arg: "<title>",
    desc: 'title for the Projects v2 board (default "<repo-name> Loop")',
    commands: ["init"],
  },
  {
    flag: "--config",
    arg: "<path>",
    desc: "use a specific hamsterwheel.toml instead of searching upward from cwd",
    commands: ["plan", "once", "run", "triage", "reconcile", "prune", "release"],
  },
  {
    flag: "--json",
    desc: "emit one JSON object on stdout; human progress goes to stderr",
    commands: "all",
  },
] as const;

export const specFor = (flag: string): FlagSpec | undefined =>
  FLAG_SPECS.find((s) => s.flag === flag || s.alias === flag);

export type ParsedArgs = {
  command: Command | null;
  help: boolean;
  version: boolean;
  /** Emit one JSON object on stdout; route human logs to stderr. */
  json: boolean;
  /** Do real work. Without it, `once`/`run` stop right after selection so the control plane is safe to exercise. */
  execute: boolean;
  /** Stop at the open PR (skip gate + merge) — supervised runs. */
  prOnly: boolean;
  /** OS-isolate the sessions in a container. */
  sandbox: boolean;
  /** claude only: full bypassPermissions instead of the scoped allow-list. */
  bypass: boolean;
  /** triage: fold missing open issues onto the board as Draft. */
  sync: boolean;
  /** prune: actually delete (default is a dry-run plan). */
  delete: boolean;
  /** release: also prepend the notes to CHANGELOG.md. */
  changelog: boolean;
  /** release: backfill — archive every Done item whose issue is closed. */
  archiveDone: boolean;
  /** release: the tag to cut (e.g. v0.5.0). */
  tag?: string;
  yes: boolean;
  dryRun: boolean;
  /** once/run: target a specific Ready+eligible issue instead of the head of the queue. */
  issue?: number;
  configPath?: string;
  /** init: board title (default "<repo-name> Loop"). */
  projectTitle?: string;
  /** Canonical flags seen on the command line, for per-command applicability validation. */
  seen: string[];
  unknown: string[];
};

export const parseArgs = (argv: string[]): ParsedArgs => {
  const args = argv.slice(2);
  const out: ParsedArgs = {
    command: null,
    help: false,
    version: false,
    json: false,
    execute: false,
    prOnly: false,
    sandbox: false,
    bypass: false,
    sync: false,
    delete: false,
    changelog: false,
    archiveDone: false,
    yes: false,
    dryRun: false,
    seen: [],
    unknown: [],
  };
  const see = (flag: string) => {
    if (!out.seen.includes(flag)) out.seen.push(flag);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--version":
      case "-v":
        out.version = true;
        break;
      case "--json":
        out.json = true;
        see("--json");
        break;
      case "--execute":
        out.execute = true;
        see("--execute");
        break;
      case "--pr-only":
        out.prOnly = true;
        see("--pr-only");
        break;
      case "--sandbox":
        out.sandbox = true;
        see("--sandbox");
        break;
      case "--bypass":
        out.bypass = true;
        see("--bypass");
        break;
      case "--sync":
        out.sync = true;
        see("--sync");
        break;
      case "--delete":
        out.delete = true;
        see("--delete");
        break;
      case "--changelog":
        out.changelog = true;
        see("--changelog");
        break;
      case "--archive-done":
        out.archiveDone = true;
        see("--archive-done");
        break;
      case "--yes":
      case "-y":
        out.yes = true;
        see("--yes");
        break;
      case "--dry-run":
        out.dryRun = true;
        see("--dry-run");
        break;
      // Value-taking flags PEEK at the next token and only consume it when it isn't itself a flag —
      // `--config --json` must report a missing path while --json still takes effect (so the error
      // itself comes out as JSON), not swallow --json as the value.
      case "--issue": {
        see("--issue");
        const raw = args[i + 1];
        // A non-numeric --issue would sail through as NaN and hang the CI wait for the full timeout.
        const n = raw !== undefined && !raw.startsWith("-") ? Number(args[++i]) : Number.NaN;
        if (Number.isInteger(n) && n > 0) out.issue = n;
        else out.unknown.push(`--issue expects a positive integer (got ${JSON.stringify(raw)})`);
        break;
      }
      case "--config": {
        see("--config");
        const v = args[i + 1];
        if (v !== undefined && !v.startsWith("-")) out.configPath = args[++i];
        else out.unknown.push(`--config expects a path (got ${JSON.stringify(v)})`);
        break;
      }
      case "--tag": {
        see("--tag");
        const v = args[i + 1];
        if (v !== undefined && !v.startsWith("-")) out.tag = args[++i];
        else out.unknown.push(`--tag expects a version tag (got ${JSON.stringify(v)})`);
        break;
      }
      case "--project-title": {
        see("--project-title");
        const v = args[i + 1];
        if (v !== undefined && !v.startsWith("-")) out.projectTitle = args[++i];
        else out.unknown.push(`--project-title expects a title (got ${JSON.stringify(v)})`);
        break;
      }
      default:
        if (a.startsWith("-")) out.unknown.push(a);
        else if (out.command === null && isCommand(a)) out.command = a;
        else out.unknown.push(a);
    }
  }
  return out;
};

/**
 * Per-command flag applicability. A flag on the wrong command is an ERROR, not silently ignored — an
 * agent that typos `plan --execute` must learn immediately that nothing would have executed.
 */
export const validateArgs = (args: ParsedArgs): string[] => {
  if (args.help || args.version) return [];
  const problems: string[] = [];
  for (const flag of args.seen) {
    const spec = specFor(flag);
    if (!spec || spec.commands === "all") continue;
    if (args.command === null || !spec.commands.includes(args.command))
      problems.push(
        `${flag} does not apply to ${args.command ? `\`${args.command}\`` : "the bare command"} — it is for: ${spec.commands.join(", ")}`,
      );
  }
  return problems;
};
