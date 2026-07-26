/** Argv parsing, kept pure so every flag combination is testable without running a command. */

export const COMMANDS = [
  "init",
  "doctor",
  "plan",
  "once",
  "run",
  "triage",
  "reconcile",
  "prune",
] as const;
export type Command = (typeof COMMANDS)[number];

export const isCommand = (v: string): v is Command => (COMMANDS as readonly string[]).includes(v);

export type ParsedArgs = {
  command: Command | null;
  help: boolean;
  version: boolean;
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
  yes: boolean;
  dryRun: boolean;
  /** once/run: target a specific Ready+eligible issue instead of the head of the queue. */
  issue?: number;
  configPath?: string;
  unknown: string[];
};

export const parseArgs = (argv: string[]): ParsedArgs => {
  const args = argv.slice(2);
  const out: ParsedArgs = {
    command: null,
    help: false,
    version: false,
    execute: false,
    prOnly: false,
    sandbox: false,
    bypass: false,
    sync: false,
    delete: false,
    yes: false,
    dryRun: false,
    unknown: [],
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
      case "--execute":
        out.execute = true;
        break;
      case "--pr-only":
        out.prOnly = true;
        break;
      case "--sandbox":
        out.sandbox = true;
        break;
      case "--bypass":
        out.bypass = true;
        break;
      case "--sync":
        out.sync = true;
        break;
      case "--delete":
        out.delete = true;
        break;
      case "--yes":
      case "-y":
        out.yes = true;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--issue": {
        // A non-numeric --issue would sail through as NaN and hang the CI wait for the full timeout.
        const n = Number(args[++i]);
        if (Number.isInteger(n) && n > 0) out.issue = n;
        else
          out.unknown.push(`--issue expects a positive integer (got ${JSON.stringify(args[i])})`);
        break;
      }
      case "--config":
        out.configPath = args[++i];
        break;
      default:
        if (a.startsWith("-")) out.unknown.push(a);
        else if (out.command === null && isCommand(a)) out.command = a;
        else out.unknown.push(a);
    }
  }
  return out;
};
