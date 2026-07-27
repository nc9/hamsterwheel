import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Config } from "@hamsterwheel/config";
import {
  type CommitEntry,
  type NotesLine,
  groupSections,
  latestSemverTag,
  parseCommitSubject,
  prependChangelog,
  renderNotes,
  suggestBump,
} from "@hamsterwheel/gate";

import { type BoardCtx, type BoardItem, archiveItem, listItems } from "./board.ts";
import type { Gh } from "./gh.ts";
import {
  commitSubjectsBetween,
  fetchTags,
  gitToplevel,
  revParse,
  tagExists,
  tagsMergedInto,
} from "./git.ts";

/**
 * `hamster release` — the ONE deliberately human-invoked mutation in the CLI ("releases are never cut
 * unattended" is doctrine; this command is the human cutting one, with hamster doing the bookkeeping).
 *
 * The issue→version mapping is derived, never stored: commits between tags → PRs (squash-title
 * suffix) → the issues those PRs closed. Cutting a release archives exactly the shipped Done items,
 * which gives Done its semantic: "merged but not yet released".
 */

export type ReleaseOpts = {
  execute: boolean;
  /** Tag to cut, e.g. v0.5.0. Absent → preview with a suggested bump. */
  tag?: string;
  /** Prepend the notes to CHANGELOG.md (execute only; the commit is left to the human). */
  changelog: boolean;
  /** Backfill arm: archive ALL Done items with closed issues; no tag, no notes, no GH release. */
  archiveDone: boolean;
  /** ISO date (YYYY-MM-DD) stamped into the notes. */
  date: string;
};

export type ReleaseDeps = {
  gh: Gh;
  cfg: Config;
  ctx: BoardCtx;
  log: (m: string) => void;
  /** Repo root for CHANGELOG.md; injected for tests. */
  cwd?: string;
};

export type ReleaseReport = {
  dryRun: boolean;
  tag: string | null;
  previousTag: string | null;
  suggested?: { level: string; next: string };
  prs: { number: number | null; type: string; title: string; issues: number[] }[];
  notes: string | null;
  archive: {
    planned: { issue: number; itemId: string }[];
    archived: { issue: number; ok: boolean; error?: string }[];
    /** Safety keeps: the issue could not be confirmed closed. Not a failure — a refusal. */
    kept: { issue: number; reason: string }[];
  };
  release?: { url: string };
  changelog?: { path: string; action: "written" | "failed"; error?: string };
};

/** Closed issues per PR, ONE aliased GraphQL query per chunk of 30. A failed chunk yields no issues
 * for its PRs — their board items simply don't archive (a failed lookup is not a passed check). */
const closingIssuesFor = async (
  gh: Gh,
  cfg: Config,
  prs: number[],
  log: (m: string) => void,
): Promise<Map<number, number[]>> => {
  const out = new Map<number, number[]>();
  const [owner, name] = cfg.repo.split("/");
  for (let i = 0; i < prs.length; i += 30) {
    const chunk = prs.slice(i, i + 30);
    const fields = chunk
      .map(
        (n) =>
          `pr${n}: pullRequest(number:${n}){closingIssuesReferences(first:50){totalCount nodes{number}}}`,
      )
      .join(" ");
    const q = `query{repository(owner:"${owner}",name:"${name}"){${fields}}}`;
    const r = await gh.tryJson<{
      data?: {
        repository?: Record<
          string,
          {
            closingIssuesReferences?: { totalCount?: number; nodes?: { number: number }[] };
          } | null
        >;
      };
    }>(["api", "graphql", "-f", `query=${q}`]);
    const repo = r?.data?.repository;
    if (!repo) {
      log(`  ⚠ could not resolve closed issues for PRs ${chunk.join(", ")} — they won't archive`);
      continue;
    }
    for (const n of chunk) {
      const refs = repo[`pr${n}`]?.closingIssuesReferences;
      const nodes = refs?.nodes ?? [];
      // Truncation fails in the safe direction (an omitted issue simply isn't archived) — but never
      // silently: an invisible cap reads as "covered everything".
      if ((refs?.totalCount ?? 0) > nodes.length)
        log(`  ⚠ PR #${n} closes ${refs!.totalCount} issues; only ${nodes.length} were fetched`);
      out.set(n, nodes.map((x) => x.number));
    }
  }
  return out;
};

const issueClosed = async (gh: Gh, repo: string, num: number): Promise<boolean> => {
  const raw = await gh.tryText([
    "issue",
    "view",
    String(num),
    "-R",
    repo,
    "--json",
    "state",
    "-q",
    ".state",
  ]);
  return raw?.trim() === "CLOSED";
};

const doneItems = (items: BoardItem[], cfg: Config): BoardItem[] =>
  items.filter(
    (i) =>
      i.status === cfg.board.status.done &&
      i.content?.repository === cfg.repo &&
      typeof i.content.number === "number",
  );

/** Archive each planned item, verifying its issue is affirmatively closed first. Per-item ok/error —
 * a partial failure is reported, never thrown. */
const archivePlanned = async (
  deps: ReleaseDeps,
  planned: { issue: number; itemId: string }[],
): Promise<Pick<ReleaseReport["archive"], "archived" | "kept">> => {
  const { gh, cfg, ctx, log } = deps;
  const archived: ReleaseReport["archive"]["archived"] = [];
  const kept: ReleaseReport["archive"]["kept"] = [];
  for (const p of planned) {
    if (!(await issueClosed(gh, cfg.repo, p.issue))) {
      kept.push({ issue: p.issue, reason: "issue not affirmatively closed" });
      log(`  · kept #${p.issue}: could not confirm the issue is closed`);
      continue;
    }
    try {
      await archiveItem(gh, ctx, p.itemId);
      archived.push({ issue: p.issue, ok: true });
      log(`  ⇣ archived #${p.issue} (item ${p.itemId} — restorable from the project archive)`);
    } catch (e) {
      archived.push({ issue: p.issue, ok: false, error: String(e).slice(0, 200) });
      log(`  ✗ failed to archive #${p.issue}: ${String(e).slice(0, 200)}`);
    }
  }
  return { archived, kept };
};

export const release = async (deps: ReleaseDeps, opts: ReleaseOpts): Promise<ReleaseReport> => {
  const { gh, cfg, ctx, log } = deps;

  // ---- backfill arm: no git, no notes — just sweep Done items whose issues closed ----
  if (opts.archiveDone) {
    const planned = doneItems(await listItems(gh, ctx), cfg).map((i) => ({
      issue: i.content!.number!,
      itemId: i.id,
    }));
    const report: ReleaseReport = {
      dryRun: !opts.execute,
      tag: null,
      previousTag: null,
      prs: [],
      notes: null,
      archive: { planned, archived: [], kept: [] },
    };
    if (opts.execute) Object.assign(report.archive, await archivePlanned(deps, planned));
    return report;
  }

  // ---- release arm ----
  // Plain semver only: the previous-tag derivation ignores anything else, so a `latest`/`v1` tag
  // would vanish from the very history walk that produced it.
  if (opts.tag && !/^v?\d+\.\d+\.\d+$/.test(opts.tag))
    throw new Error(`--tag must be a plain semver tag (vX.Y.Z), got "${opts.tag}"`);
  await fetchTags(cfg.baseBranch);
  const baseRef = `origin/${cfg.baseBranch}`;
  const baseSha = await revParse(baseRef);
  if (!baseSha) throw new Error(`cannot resolve ${baseRef} — fetch failed or the branch is missing`);
  if (opts.tag && (await tagExists(opts.tag)))
    throw new Error(`tag ${opts.tag} already exists — never overwritten; pick the next version`);

  const previousTag = latestSemverTag(await tagsMergedInto(baseSha));
  const subjects = await commitSubjectsBetween(previousTag, baseSha);
  const entries: CommitEntry[] = subjects.map((s) => {
    const parsed = parseCommitSubject(s);
    if (parsed) return parsed;
    // Unparseable subjects (merge commits, freeform) still appear, verbatim, under Other.
    const pr = /\(#(\d+)\)\s*$/.exec(s);
    return {
      type: "(raw)",
      scope: null,
      breaking: false,
      description: s,
      pr: pr ? Number(pr[1]) : null,
      subject: s,
    };
  });
  const suggested = suggestBump(entries, previousTag);
  const tag = opts.tag ?? suggested.next;

  const prNums = [...new Set(entries.map((e) => e.pr).filter((p): p is number => p !== null))];
  const issuesByPr = await closingIssuesFor(gh, cfg, prNums, log);
  const lines: NotesLine[] = entries.map((e) => ({
    entry: e,
    issues: e.pr !== null ? (issuesByPr.get(e.pr) ?? []) : [],
  }));
  const notes = renderNotes({
    tag,
    date: opts.date,
    sections: groupSections(lines),
    compareUrl: previousTag
      ? `https://github.com/${cfg.repo}/compare/${previousTag}...${tag}`
      : null,
  });

  const shipped = new Set(lines.flatMap((l) => l.issues));
  const planned = doneItems(await listItems(gh, ctx), cfg)
    .filter((i) => shipped.has(i.content!.number!))
    .map((i) => ({ issue: i.content!.number!, itemId: i.id }));

  const report: ReleaseReport = {
    dryRun: !opts.execute,
    tag,
    previousTag,
    ...(opts.tag ? {} : { suggested }),
    prs: entries
      .filter((e) => e.pr !== null || e.type !== "(raw)")
      .map((e) => ({
        number: e.pr,
        type: e.type,
        title: e.description,
        issues: e.pr !== null ? (issuesByPr.get(e.pr) ?? []) : [],
      })),
    notes,
    archive: { planned, archived: [], kept: [] },
  };
  if (!opts.execute) return report;

  // Tag + GitHub Release, pinned to the REMOTE base tip — never the local checkout's HEAD.
  const url = (
    await gh.text([
      "release",
      "create",
      tag,
      "-R",
      cfg.repo,
      "--target",
      baseSha,
      "--title",
      tag,
      "--notes",
      notes,
    ])
  ).trim();
  report.release = { url };
  log(`  ✓ released ${tag} → ${url}`);

  Object.assign(report.archive, await archivePlanned(deps, planned));

  if (opts.changelog) {
    // Repo toplevel, not cwd — running from a subdirectory must not scatter CHANGELOG.md copies.
    const root = deps.cwd ?? (await gitToplevel()) ?? process.cwd();
    const path = join(root, "CHANGELOG.md");
    try {
      const existing = await readFile(path, "utf8").catch(() => null);
      await writeFile(path, prependChangelog(existing, notes));
      report.changelog = { path, action: "written" };
      log(`  ✓ CHANGELOG.md updated (commit it yourself — the release never pushes commits)`);
    } catch (e) {
      // The release and archives already happened; a changelog failure must not throw the report away.
      report.changelog = { path, action: "failed", error: String(e).slice(0, 200) };
      log(`  ✗ CHANGELOG.md write failed: ${String(e).slice(0, 200)}`);
    }
  }
  return report;
};

export const renderRelease = (r: ReleaseReport, log: (m: string) => void): void => {
  if (r.notes) {
    log(`\n${r.notes}`);
    log(
      r.previousTag
        ? `previous tag: ${r.previousTag}`
        : "no previous semver tag — notes cover the whole history",
    );
    if (r.suggested) log(`suggested bump: ${r.suggested.level} → ${r.suggested.next}`);
  }
  const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;
  log(
    r.archive.planned.length
      ? `\narchive plan: ${plural(r.archive.planned.length, "Done item")} — ${r.archive.planned.map((p) => `#${p.issue}`).join(" ")}`
      : "\narchive plan: nothing to archive",
  );
  if (r.dryRun) {
    log(
      r.tag
        ? `\n(dry run — \`hamster release --tag ${r.tag} --execute\` cuts the release and archives)`
        : "\n(dry run — pass --execute to archive; each item is archived only after its issue is confirmed closed)",
    );
    return;
  }
  if (r.release) log(`\nrelease: ${r.release.url}`);
  const failed = r.archive.archived.filter((a) => !a.ok);
  const parts = [
    `archived ${r.archive.archived.length - failed.length}/${r.archive.planned.length}`,
  ];
  if (r.archive.kept.length)
    parts.push(`kept ${r.archive.kept.map((k) => `#${k.issue}`).join(" ")} (unconfirmed close)`);
  if (failed.length) parts.push(`✗ failed ${failed.map((f) => `#${f.issue}`).join(" ")}`);
  log(parts.join(" · "));
};
