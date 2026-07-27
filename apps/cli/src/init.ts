import { readFile, writeFile } from "node:fs/promises";

import { CONFIG_FILENAME, type Config, loadConfig, parseConfigText } from "@hamsterwheel/config";

import { BLOCK_START, buildAgentDoc, spliceMarkedBlock } from "./agent-doc.ts";
import { Gh } from "./gh.ts";
import { type Check, printChecks, runChecks } from "./doctor.ts";

/**
 * First-run setup. Idempotent, and it PRINTS EVERY MUTATION BEFORE MAKING IT — a first run against a
 * real org must never be a surprise. `--dry-run` stops after printing; `--yes` skips the prompts;
 * nothing outside `hamsterwheel.toml` is written without an explicit yes. Off a TTY (agents, CI) it
 * refuses to prompt at all: --yes or --dry-run is mandatory.
 */

export type InitOptions = {
  cwd: string;
  yes: boolean;
  dryRun: boolean;
  /** Board title, default "Loop". */
  projectTitle?: string;
  log: (m: string) => void;
  ask?: (question: string) => Promise<string>;
  gh?: Gh;
};

/** Structured record of what init found and did — the `--json` output. */
export type InitReport = {
  checks: Check[];
  repo?: string;
  project?: { number: number; title: string } | null;
  labelsCreated?: string[];
  config?: { path: string; action: "written" | "overwritten" | "unchanged" | "kept" | "proposed" };
  agentDocs?: { file: string; action: string }[];
};

const defaultAsk = async (question: string): Promise<string> => {
  process.stdout.write(question);
  for await (const line of console) return line.trim();
  return "";
};

const confirm = async (opts: InitOptions, question: string): Promise<boolean> => {
  if (opts.yes) return true;
  const ask = opts.ask ?? defaultAsk;
  return /^y(es)?$/i.test((await ask(`${question} [y/N] `)).trim());
};

/** `owner/name` of the repo the cwd is in, via gh. */
const detectRepo = async (gh: Gh): Promise<string | null> =>
  (await gh.tryText(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]))?.trim() ||
  null;

const STATUS_OPTIONS = ["Draft", "Ready", "In Progress", "In Review", "Blocked", "Done"];
const BLOCKED_OPTIONS = [
  "needs-criteria",
  "needs-prod-migration",
  "needs-decision",
  "dep-open",
  "ci-red",
  "rubric-fail",
];

/** The fixed part of the `loop:*` vocabulary. Model labels are open-ended, so they're documented, not created. */
export const LOOP_LABELS = [
  ...["claude", "codex", "opencode"].flatMap((r) => [
    `loop:impl-runner-${r}`,
    `loop:review-runner-${r}`,
  ]),
  ...["minimal", "low", "medium", "high", "xhigh", "max"].flatMap((e) => [
    `loop:impl-effort-${e}`,
    `loop:review-effort-${e}`,
  ]),
];
/** Priority + size labels the queue ranks on. Without these every issue sorts as unprioritized/L. */
export const RANK_LABELS = [
  "P0",
  "P1",
  "P2",
  "P3",
  "size: XS",
  "size: S",
  "size: M",
  "size: L",
  "size: XL",
];

const renderConfig = (v: {
  repo: string;
  projectNumber: number;
  projectTitle: string;
  baseBranch: string;
}): string =>
  `# Written by \`hamster init\`. See hamsterwheel.example.toml for every option.
repo = "${v.repo}"

# Paths that mean "this PR changes a schema migration" → never auto-merged. EDIT THIS for your repo.
migration_path_regex = "(^|/)(migrations|drizzle)/"

base_branch = "${v.baseBranch}"
branch_prefix = "loop"
install_cmd = "bun install"

[project]
number = ${v.projectNumber}
title = "${v.projectTitle}"

max_review_rounds = 4

[runners.implement]
runner = "claude"
strong_model = "opus"
cheap_model = "sonnet"

[runners.review]
runner = "claude"
strong_model = "opus"
cheap_model = "sonnet"
`;

const ensureProject = async (
  gh: Gh,
  opts: InitOptions,
  owner: string,
  title: string,
): Promise<{ number: number; title: string } | null> => {
  const list = await gh.json<{ projects: { number: number; id: string; title: string }[] }>([
    "project",
    "list",
    "--owner",
    owner,
    "--format",
    "json",
    "--limit",
    "100",
  ]);
  const existing = list.projects.find((p) => p.title === title);
  if (existing) {
    opts.log(`  · project #${existing.number} "${title}" already exists`);
    return { number: existing.number, title };
  }
  opts.log(`  + CREATE Projects v2 board "${title}" under ${owner}`);
  if (opts.dryRun) return null;
  if (!(await confirm(opts, `    create it?`))) return null;
  const created = await gh.json<{ number: number }>([
    "project",
    "create",
    "--owner",
    owner,
    "--title",
    title,
    "--format",
    "json",
  ]);
  return { number: created.number, title };
};

const ensureFields = async (
  gh: Gh,
  opts: InitOptions,
  owner: string,
  projectNumber: number,
): Promise<void> => {
  const fl = await gh.json<{
    fields: { id: string; name: string; options?: { name: string }[] }[];
  }>([
    "project",
    "field-list",
    String(projectNumber),
    "--owner",
    owner,
    "--format",
    "json",
    "--limit",
    "100",
  ]);
  const find = (name: string) => fl.fields.find((f) => f.name.toLowerCase() === name.toLowerCase());

  const wanted: { name: string; type: "SINGLE_SELECT" | "TEXT"; options?: string[] }[] = [
    { name: "Status", type: "SINGLE_SELECT", options: STATUS_OPTIONS },
    { name: "Owner", type: "TEXT" },
    { name: "Blocked reason", type: "SINGLE_SELECT", options: BLOCKED_OPTIONS },
  ];
  for (const w of wanted) {
    const existing = find(w.name);
    if (existing) {
      // gh cannot add options to an EXISTING single-select field, so a partial field is reported for a
      // human to finish rather than silently left half-provisioned.
      const missing = (w.options ?? []).filter(
        (o) => !(existing.options ?? []).some((e) => e.name === o),
      );
      opts.log(
        missing.length
          ? `  ! field "${w.name}" exists but is missing options: ${missing.join(", ")} — add them in the board UI`
          : `  · field "${w.name}" ready`,
      );
      continue;
    }
    opts.log(
      `  + CREATE field "${w.name}" (${w.type}${w.options ? `: ${w.options.join(", ")}` : ""})`,
    );
    if (opts.dryRun) continue;
    await gh.text([
      "project",
      "field-create",
      String(projectNumber),
      "--owner",
      owner,
      "--name",
      w.name,
      "--data-type",
      w.type,
      ...(w.options ? ["--single-select-options", w.options.join(",")] : []),
    ]);
  }
};

/** Returns the labels it created (or would create, on a dry run). */
const ensureLabels = async (gh: Gh, opts: InitOptions, repo: string): Promise<string[]> => {
  const existing = new Set(
    (
      (await gh.tryJson<{ name: string }[]>([
        "label",
        "list",
        "-R",
        repo,
        "--limit",
        "500",
        "--json",
        "name",
      ])) ?? []
    ).map((l) => l.name.toLowerCase()),
  );
  const missing = [...RANK_LABELS, ...LOOP_LABELS].filter((l) => !existing.has(l.toLowerCase()));
  if (!missing.length) {
    opts.log("  · all loop labels present");
    return [];
  }
  opts.log(
    `  + CREATE ${missing.length} label(s): ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? " …" : ""}`,
  );
  if (opts.dryRun) return missing;
  for (const name of missing)
    await gh
      .text([
        "label",
        "create",
        name,
        "-R",
        repo,
        "--color",
        "ededed",
        "--description",
        "hamsterwheel",
      ])
      .catch(() => {});
  return missing;
};

const writeAgentDocs = async (
  opts: InitOptions,
  cfg: Config,
): Promise<{ file: string; action: string }[]> => {
  const block = buildAgentDoc(cfg);
  const actions: { file: string; action: string }[] = [];
  opts.log("\n─── issue contract (paste into your agent guidance) ───────────────────────");
  opts.log(block);
  opts.log("──────────────────────────────────────────────────────────────────────────\n");
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const path = `${opts.cwd}/${name}`;
    // never create agent guidance that doesn't exist yet
    const existing = await readFile(path, "utf8").catch(() => null);
    if (existing === null) {
      actions.push({ file: name, action: "absent" });
      continue;
    }
    const next = spliceMarkedBlock(existing, block);
    if (next === null) {
      opts.log(
        `  ! ${name} has a ${BLOCK_START} marker with no matching end marker — leaving it alone`,
      );
      actions.push({ file: name, action: "broken-markers" });
      continue;
    }
    if (next === existing) {
      opts.log(`  · ${name} already up to date`);
      actions.push({ file: name, action: "unchanged" });
      continue;
    }
    const replace = existing.includes(BLOCK_START);
    opts.log(
      `  + ${replace ? "REPLACE the hamsterwheel block in" : "APPEND the block to"} ${name}`,
    );
    if (opts.dryRun) {
      actions.push({ file: name, action: "proposed" });
      continue;
    }
    if (await confirm(opts, `    write ${name}?`)) {
      await writeFile(path, next);
      actions.push({ file: name, action: replace ? "replaced" : "appended" });
    } else actions.push({ file: name, action: "declined" });
  }
  return actions;
};

export const init = async (opts: InitOptions): Promise<{ code: number; report: InitReport }> => {
  const gh = opts.gh ?? new Gh();
  const report: InitReport = { checks: [] };
  // Off a TTY there is nobody to answer a y/N prompt; hanging on stdin would look like a wedged agent.
  const canPrompt = opts.ask !== undefined || process.stdin.isTTY === true;
  if (!opts.yes && !opts.dryRun && !canPrompt) {
    opts.log(
      "✗ stdin is not a TTY, so init cannot prompt — pass --yes to apply every mutation, or --dry-run to preview them.",
    );
    return { code: 1, report };
  }
  opts.log(`🐹 hamster init${opts.dryRun ? " (dry run — nothing will be written)" : ""}\n`);

  opts.log("Prerequisites:");
  const checks = await runChecks({ cwd: opts.cwd, gh });
  report.checks = checks;
  printChecks(checks, opts.log);
  const blocking = checks.filter(
    (c) => c.status === "fail" && c.name !== "project board" && c.name !== "config",
  );
  if (blocking.length) {
    opts.log(`\n✗ fix the ${blocking.length} blocking problem(s) above first.`);
    return { code: 1, report };
  }

  const repo = await detectRepo(gh);
  if (!repo) {
    opts.log(
      "\n✗ could not determine the repo (`gh repo view` failed) — run init inside a GitHub checkout.",
    );
    return { code: 1, report };
  }
  report.repo = repo;
  const owner = repo.split("/")[0]!;
  const title = opts.projectTitle ?? "Loop";
  opts.log(`\nBoard (${owner}):`);
  const project = await ensureProject(gh, opts, owner, title);
  report.project = project;
  if (project) await ensureFields(gh, opts, owner, project.number);

  opts.log(`\nLabels (${repo}):`);
  report.labelsCreated = await ensureLabels(gh, opts, repo);

  const configPath = `${opts.cwd}/${CONFIG_FILENAME}`;
  const baseBranch =
    (
      await gh.tryText([
        "repo",
        "view",
        "-R",
        repo,
        "--json",
        "defaultBranchRef",
        "-q",
        ".defaultBranchRef.name",
      ])
    )?.trim() || "main";
  const rendered = renderConfig({
    repo,
    projectNumber: project?.number ?? 1,
    projectTitle: title,
    baseBranch,
  });
  opts.log(`\nConfig:`);
  const current = await readFile(configPath, "utf8").catch(() => null);
  if (current !== null) {
    if (current === rendered) {
      opts.log(`  · ${CONFIG_FILENAME} already matches`);
      report.config = { path: configPath, action: "unchanged" };
    } else {
      opts.log(`  ! ${CONFIG_FILENAME} exists and differs. Proposed:\n`);
      for (const line of rendered.split("\n")) opts.log(`    | ${line}`);
      if (!opts.dryRun && (await confirm(opts, `  overwrite ${CONFIG_FILENAME}?`))) {
        await writeFile(configPath, rendered);
        report.config = { path: configPath, action: "overwritten" };
      } else {
        opts.log("  · kept the existing file");
        report.config = { path: configPath, action: opts.dryRun ? "proposed" : "kept" };
      }
    }
  } else {
    opts.log(`  + WRITE ${configPath}`);
    report.config = { path: configPath, action: opts.dryRun ? "proposed" : "written" };
    if (!opts.dryRun) await writeFile(configPath, rendered);
  }

  // Parse what we just proposed so the agent-doc block reflects the real (validated) names even on a dry run.
  const cfg = await loadConfig(configPath).catch(() => parseConfigText(rendered));
  report.agentDocs = await writeAgentDocs(opts, cfg);

  opts.log("\nSummary:");
  report.checks = await runChecks({ cwd: opts.cwd, gh });
  printChecks(report.checks, opts.log);
  opts.log(
    `\nNext: edit \`migration_path_regex\` in ${CONFIG_FILENAME} for your repo, move an issue to Ready, then run \`hamster plan\`.`,
  );
  return { code: 0, report };
};
