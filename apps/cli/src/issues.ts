import type { Config } from "@hamsterwheel/config";
import {
  compareIssues,
  hasAcceptanceCriteria,
  isEpicTitle,
  parseDeps,
  priorityRank,
  screenInjection,
  sizeRank,
} from "@hamsterwheel/gate";

import { type BoardItem, itemField } from "./board.ts";
import type { Gh } from "./gh.ts";

/** A board item enriched with everything the queue, the policy and the prompts need. */
export type LoopIssue = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt: string;
  priority: number;
  size: number;
  hasCriteria: boolean;
  deps: number[];
  /** Tripped prompt-injection markers (empty = clean). Non-empty is a hard stop, never a warning. */
  injection: string[];
  itemId: string;
  owner?: string;
  /** Issue state from GitHub. The BOARD drifts (items linger Ready after shipping); the issue does not. */
  state: "OPEN" | "CLOSED";
};

type IssueView = {
  title: string;
  body: string | null;
  labels: { name: string }[];
  createdAt: string;
  state: string;
};

export const enrichItem = async (
  gh: Gh,
  cfg: Config,
  item: BoardItem,
): Promise<LoopIssue | null> => {
  const num = item.content?.number;
  // Items from other repos (a public triage inbox synced onto the same board) are visible but never
  // worked — the loop only has a worktree for its own repo.
  if (!num || item.content?.repository !== cfg.repo) return null;
  const d = await gh.json<IssueView>([
    "issue",
    "view",
    String(num),
    "-R",
    cfg.repo,
    "--json",
    "title,body,labels,createdAt,state",
  ]);
  const labels = d.labels.map((l) => l.name);
  const body = d.body ?? "";
  return {
    number: num,
    title: d.title,
    body,
    labels,
    createdAt: d.createdAt,
    priority: priorityRank(labels),
    size: sizeRank(labels),
    hasCriteria: hasAcceptanceCriteria(body, cfg.criteriaHeading),
    deps: parseDeps(body),
    injection: screenInjection(`${d.title}\n${body}`),
    itemId: item.id,
    owner: itemField(item, cfg.board.ownerField),
    state: d.state?.toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN",
  };
};

export const isOpen = async (gh: Gh, repo: string, num: number): Promise<boolean> =>
  (
    await gh.text(["issue", "view", String(num), "-R", repo, "--json", "state", "-q", ".state"])
  ).trim() === "OPEN";

/** Epics are containers: a title marker OR native sub-issues. The loop works the children. */
export const isEpic = async (gh: Gh, cfg: Config, num: number, title: string): Promise<boolean> => {
  if (isEpicTitle(title)) return true;
  const [owner, name] = cfg.repo.split("/");
  const r = await gh.tryJson<{
    data?: { repository?: { issue?: { subIssues?: { totalCount: number } } } };
  }>([
    "api",
    "graphql",
    "-F",
    `n=${num}`, // typed Int via -F; never string-interpolate an identifier into the query
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-f",
    "query=query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){subIssues{totalCount}}}}",
  ]);
  return (r?.data?.repository?.issue?.subIssues?.totalCount ?? 0) > 0;
};

/**
 * A merged PR that closes this issue — the corroboration a "clean no-op" implement session needs before
 * the loop dares call it Done. GraphQL is the reliable signal; parsing the agent's prose for a PR number
 * was luck that broke in production.
 */
export const findPriorClosingPr = async (
  gh: Gh,
  cfg: Config,
  num: number,
): Promise<{ number: number; url: string } | null> => {
  const [owner, name] = cfg.repo.split("/");
  const r = await gh.tryJson<{
    data?: {
      repository?: {
        issue?: {
          closedByPullRequestsReferences?: {
            nodes?: { number: number; url: string; merged: boolean }[];
          };
        };
      };
    };
  }>([
    "api",
    "graphql",
    "-F",
    `n=${num}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-f",
    "query=query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){closedByPullRequestsReferences(first:20,includeClosedPrs:true){nodes{number url merged}}}}}",
  ]);
  const merged = r?.data?.repository?.issue?.closedByPullRequestsReferences?.nodes?.find(
    (p) => p.merged,
  );
  return merged ? { number: merged.number, url: merged.url } : null;
};

export type QueueSkip = { num: number; why: string };
export type Queue = { eligible: LoopIssue[]; skipped: QueueSkip[] };

/**
 * Rank the Ready queue. READ-ONLY — no board mutation happens here, so `plan` and every tick of `run`
 * share exactly one selection path. Skip reasons are returned rather than logged so `plan` can show them.
 */
export const buildQueue = async (gh: Gh, cfg: Config, items: BoardItem[]): Promise<Queue> => {
  const ready = items.filter((i) => i.status === cfg.board.status.ready);
  const enriched = (await Promise.all(ready.map((i) => enrichItem(gh, cfg, i)))).filter(
    (i): i is LoopIssue => i !== null,
  );
  const eligible: LoopIssue[] = [];
  const skipped: QueueSkip[] = [];
  for (const iss of enriched) {
    if (iss.injection.length) {
      skipped.push({
        num: iss.number,
        why: `suspected prompt-injection (${iss.injection.join(", ")}) → ${cfg.board.blockedReasons.needsDecision}`,
      });
      continue;
    }
    // Board drift: an item can sit in Ready long after a merged PR closed the issue. Working it burns a
    // whole session re-doing shipped work, so cross-check the issue state, which never drifts.
    if (iss.state === "CLOSED") {
      skipped.push({ num: iss.number, why: "issue is CLOSED — board drift; move it to Done" });
      continue;
    }
    if (!iss.hasCriteria) {
      // Name the likely cause: a heading typo (`## Acceptance` for `## Acceptance Criteria`) makes an
      // issue silently vanish from the queue, and a silent eligibility failure looks like an empty backlog.
      const hint = /-\s*\[[ x]\]/.test(iss.body)
        ? ` — body HAS a checklist but no \`## ${cfg.criteriaHeading}\` heading (typo?)`
        : "";
      skipped.push({
        num: iss.number,
        why: `no ${cfg.criteriaHeading} checklist${hint} → ${cfg.board.blockedReasons.needsCriteria}`,
      });
      continue;
    }
    if (await isEpic(gh, cfg, iss.number, iss.title)) {
      skipped.push({ num: iss.number, why: "epic — work its sub-issues" });
      continue;
    }
    const openDeps: number[] = [];
    for (const d of iss.deps) if (await isOpen(gh, cfg.repo, d)) openDeps.push(d);
    if (openDeps.length) {
      skipped.push({
        num: iss.number,
        why: `blocked by open dep(s) ${openDeps.map((n) => `#${n}`).join(", ")}`,
      });
      continue;
    }
    eligible.push(iss);
  }
  eligible.sort(compareIssues);
  return { eligible, skipped };
};

/** `<prefix>/<issue>-<slug>` — the implement branch. Slug is derived from the title, never trusted raw. */
export const branchName = (cfg: Config, iss: Pick<LoopIssue, "number" | "title">): string =>
  `${cfg.branchPrefix}/${iss.number}-${iss.title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 40)}`;
