import type { Config } from "@hamsterwheel/config";

import type { Gh } from "./gh.ts";

/**
 * GitHub Projects v2 control plane. Field and option NAMES come from config; the ids are resolved at
 * runtime by name, so a board that was renamed (or provisioned by hand) still works without an
 * `init` re-run.
 */

export type BoardItem = {
  id: string;
  title?: string;
  status?: string;
  content?: { number?: number; repository?: string; title?: string; url?: string };
  /** Every other column `item-list` emitted, keyed by its lowercased field name. */
  fields: Record<string, unknown>;
};

export type BoardCtx = {
  projectNumber: number;
  projectId: string;
  owner: string;
  statusFieldId: string;
  ownerFieldId: string;
  /** Field NAMES as configured — fetchItemState matches field values by name, not id. */
  statusFieldName: string;
  ownerFieldName: string;
  /** Boards without a Blocked-reason field still work; the reason then rides the issue comment only. */
  blockedFieldId: string | null;
  statusOptions: Record<string, string>; // option name → option id
  blockedOptions: Record<string, string>;
};

type ProjectList = { projects: { number: number; id: string; title: string }[] };
type FieldList = {
  fields: { id: string; name: string; options?: { id: string; name: string }[] }[];
};

// `gh project item-list` SILENTLY TRUNCATES at --limit (the default is small) and gives no "there is
// more" signal, so a partial page reads as a complete board. Always ask for far more than any real
// board holds, and never infer a total from a page.
export const ITEM_LIMIT = "1000";
const FIELD_LIMIT = "100";

/** Keys of the `item-list` JSON that are structural, not board fields. */
const STRUCTURAL_KEYS = new Set(["id", "title", "status", "content", "repository"]);

export const loadBoardCtx = async (gh: Gh, cfg: Config): Promise<BoardCtx> => {
  const owner = cfg.project.owner;
  const list = await gh.json<ProjectList>([
    "project",
    "list",
    "--owner",
    owner,
    "--format",
    "json",
    "--limit",
    "100",
  ]);
  const project =
    (cfg.project.number !== undefined &&
      list.projects.find((p) => p.number === cfg.project.number)) ||
    (cfg.project.title !== undefined && list.projects.find((p) => p.title === cfg.project.title)) ||
    undefined;
  if (!project)
    throw new Error(
      `project ${cfg.project.number ?? `"${cfg.project.title}"`} not found under owner ${owner} — run \`hamster init\``,
    );

  const fl = await gh.json<FieldList>([
    "project",
    "field-list",
    String(project.number),
    "--owner",
    owner,
    "--format",
    "json",
    "--limit",
    FIELD_LIMIT,
  ]);
  const field = (name: string) =>
    fl.fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
  const options = (name: string): Record<string, string> =>
    Object.fromEntries((field(name)?.options ?? []).map((o) => [o.name, o.id]));

  const status = field(cfg.board.statusField);
  const ownerField = field(cfg.board.ownerField);
  if (!status)
    throw new Error(
      `board field "${cfg.board.statusField}" not found on project #${project.number}`,
    );
  if (!ownerField)
    throw new Error(
      `board field "${cfg.board.ownerField}" not found on project #${project.number} — the loop needs a text field for atomic claims`,
    );

  return {
    projectNumber: project.number,
    projectId: project.id,
    owner,
    statusFieldId: status.id,
    ownerFieldId: ownerField.id,
    statusFieldName: cfg.board.statusField,
    ownerFieldName: cfg.board.ownerField,
    blockedFieldId: field(cfg.board.blockedReasonField)?.id ?? null,
    statusOptions: options(cfg.board.statusField),
    blockedOptions: options(cfg.board.blockedReasonField),
  };
};

export const listItems = async (gh: Gh, ctx: BoardCtx): Promise<BoardItem[]> => {
  const r = await gh.json<{ items: Record<string, unknown>[] }>([
    "project",
    "item-list",
    String(ctx.projectNumber),
    "--owner",
    ctx.owner,
    "--format",
    "json",
    "--limit",
    ITEM_LIMIT,
  ]);
  return (r.items ?? []).map((raw) => ({
    id: String(raw.id ?? ""),
    title: typeof raw.title === "string" ? raw.title : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
    content: (raw.content ?? undefined) as BoardItem["content"],
    fields: Object.fromEntries(
      Object.entries(raw)
        .filter(([k]) => !STRUCTURAL_KEYS.has(k))
        .map(([k, v]) => [k.toLowerCase(), v]),
    ),
  }));
};

/** Read a board field off an item by its display name (`item-list` lowercases and strips spaces). */
export const itemField = (item: BoardItem, fieldName: string): string | undefined => {
  const wanted = fieldName.toLowerCase();
  const compact = wanted.replaceAll(/\s+/g, "");
  for (const [k, v] of Object.entries(item.fields))
    if ((k === wanted || k.replaceAll(/\s+/g, "") === compact) && typeof v === "string") return v;
  return undefined;
};

const editField = async (gh: Gh, ctx: BoardCtx, itemId: string, fieldId: string, value: string[]) =>
  gh.text([
    "project",
    "item-edit",
    "--id",
    itemId,
    "--project-id",
    ctx.projectId,
    "--field-id",
    fieldId,
    ...value,
  ]);

/**
 * Status + Owner for ONE item. The whole point is cost: `listItems` pulls every item on the board with
 * all its field values, and on a 385-item board that burns the 5,000-point GraphQL budget in about two
 * claims — a serial run died mid-batch on `API rate limit exceeded`. Re-reading one item before claiming
 * gives the same freshness guarantee for O(1).
 *
 * Returns null when the item can't be read; callers must treat that as "don't claim", never as "clear".
 */
export const fetchItemState = async (
  gh: Gh,
  ctx: BoardCtx,
  itemId: string,
): Promise<{ status?: string; owner?: string } | null> => {
  const q = `query($i:ID!){node(id:$i){... on ProjectV2Item{fieldValues(first:30){nodes{
      __typename
      ... on ProjectV2ItemFieldTextValue{text field{... on ProjectV2FieldCommon{name}}}
      ... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}}
    }}}}}`;
  const r = await gh.tryJson<{
    data?: {
      node?: {
        fieldValues?: {
          nodes?: {
            __typename?: string;
            text?: string;
            name?: string;
            field?: { name?: string };
          }[];
        };
      };
    };
  }>(["api", "graphql", "-f", `query=${q}`, "-f", `i=${itemId}`]);
  const nodes = r?.data?.node?.fieldValues?.nodes;
  if (!nodes) return null;
  const byField = (want: string): { text?: string; name?: string } | undefined =>
    nodes.find((n) => n.field?.name?.toLowerCase() === want.toLowerCase());
  return {
    status: byField(ctx.statusFieldName)?.name,
    owner: byField(ctx.ownerFieldName)?.text,
  };
};

export const setStatus = async (
  gh: Gh,
  ctx: BoardCtx,
  itemId: string,
  statusName: string,
): Promise<void> => {
  const optionId = ctx.statusOptions[statusName];
  if (!optionId)
    throw new Error(
      `status option "${statusName}" not on the board (have: ${Object.keys(ctx.statusOptions).join(", ") || "none"})`,
    );
  await editField(gh, ctx, itemId, ctx.statusFieldId, ["--single-select-option-id", optionId]);
};

export const setOwner = async (
  gh: Gh,
  ctx: BoardCtx,
  itemId: string,
  runId: string,
): Promise<void> => {
  await editField(gh, ctx, itemId, ctx.ownerFieldId, ["--text", runId]);
};

/**
 * Release a claim. NOT `item-edit --text ""` — GitHub rejects that with "no changes to make", so the
 * obvious implementation silently never clears anything. Combined with a `.catch(() => {})` at the call
 * site (a release must not mask the original failure), that left every rolled-back item wearing a dead
 * Owner forever, and the claim guard skipped it on every subsequent run. Clearing a field value is its
 * own mutation.
 */
export const clearOwner = async (gh: Gh, ctx: BoardCtx, itemId: string): Promise<void> => {
  await gh.text([
    "api",
    "graphql",
    "-f",
    "query=mutation($p:ID!,$i:ID!,$f:ID!){clearProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f}){projectV2Item{id}}}",
    "-f",
    `p=${ctx.projectId}`,
    "-f",
    `i=${itemId}`,
    "-f",
    `f=${ctx.ownerFieldId}`,
  ]);
};

/**
 * Move an item to Blocked with a reason. The reason option is best-effort: a board without the field (or
 * without that option) must still get the STATUS change — losing the label is survivable, silently
 * leaving the item Ready is not (it would be re-claimed on the next tick).
 */
export const setBlocked = async (
  gh: Gh,
  ctx: BoardCtx,
  cfg: Config,
  itemId: string,
  reason: string,
): Promise<void> => {
  await setStatus(gh, ctx, itemId, cfg.board.status.blocked);
  const optionId = ctx.blockedOptions[reason];
  if (ctx.blockedFieldId && optionId)
    await editField(gh, ctx, itemId, ctx.blockedFieldId, [
      "--single-select-option-id",
      optionId,
    ]).catch(() => {});
};

/**
 * Archive (not delete) a board item — hidden from views and `item-list`, restorable from the
 * project's archive. Used by `release`: Done means "merged, not yet released"; archiving at release
 * time is what keeps the board a queue instead of a history.
 */
export const archiveItem = async (gh: Gh, ctx: BoardCtx, itemId: string): Promise<void> => {
  await gh.text([
    "api",
    "graphql",
    "-f",
    "query=mutation($p:ID!,$i:ID!){archiveProjectV2Item(input:{projectId:$p,itemId:$i}){item{id}}}",
    "-f",
    `p=${ctx.projectId}`,
    "-f",
    `i=${itemId}`,
  ]);
};

export const addItem = async (gh: Gh, ctx: BoardCtx, url: string): Promise<string> => {
  const r = await gh.json<{ id: string }>([
    "project",
    "item-add",
    String(ctx.projectNumber),
    "--owner",
    ctx.owner,
    "--url",
    url,
    "--format",
    "json",
  ]);
  return r.id;
};

export const comment = async (gh: Gh, repo: string, issue: number, body: string): Promise<void> => {
  await gh.text(["issue", "comment", String(issue), "-R", repo, "--body", body]);
};
