import type { Config } from "@hamsterwheel/config";

/**
 * The issue contract, as a block to paste into CLAUDE.md / AGENTS.md. This is the human⇄loop interface:
 * if the repo's agent guidance doesn't state it, issues get filed without acceptance criteria and the
 * loop blocks every one of them.
 *
 * Both the block builder and the splice are PURE — `init` only decides whether to write the result.
 */

export const BLOCK_START = "<!-- hamsterwheel:start -->";
export const BLOCK_END = "<!-- hamsterwheel:end -->";

export const buildAgentDoc = (cfg: Config): string =>
  [
    "## hamsterwheel issue contract",
    "",
    `The autonomous loop works issues on the GitHub Projects v2 board for \`${cfg.repo}\`. It is the IC; you are the PM.`,
    "",
    "**An issue is only eligible when its body contains:**",
    "",
    "```markdown",
    `## ${cfg.criteriaHeading}`,
    "- [ ] observable, checkable behavior",
    "- [ ] one checkbox per requirement",
    "",
    "Depends on #123        (optional; `Blocked by #123` also works)",
    "```",
    "",
    `The \`## ${cfg.criteriaHeading}\` heading is matched LITERALLY and is typo-sensitive: \`## Acceptance\` or a reworded heading makes the issue silently drop out of the queue with no error anywhere (run \`hamster plan\` — it prints a skip reason per excluded issue).`,
    "",
    `The checklist IS the merge rubric — an adversarial read-only session grades the resulting codebase against every box. No checklist → the loop blocks the issue as \`${cfg.board.blockedReasons.needsCriteria}\`.`,
    "",
    "**Board statuses** (the whole interface):",
    "",
    `- \`${cfg.board.status.draft}\` — human scratch state; the loop ignores it.`,
    `- \`${cfg.board.status.ready}\` — criteria + priority (\`P0\`–\`P3\`) + size (\`size: XS\`–\`size: XL\`) + no open deps. Eligible.`,
    `- \`${cfg.board.status.inProgress}\` — claimed; the \`${cfg.board.ownerField}\` field holds the run id.`,
    `- \`${cfg.board.status.inReview}\` — PR open and linked.`,
    `- \`${cfg.board.status.blocked}\` — a human is needed; the blocked reason says why.`,
    `- \`${cfg.board.status.done}\` — merged.`,
    "",
    "**Selection order:** priority (P0→P3) → size (smallest first) → age (oldest first).",
    "",
    "**Label vocabulary** (all optional; an invalid value silently falls back to the default policy):",
    "",
    "| label | effect |",
    "|---|---|",
    "| `loop:impl-runner-<claude\\|codex\\|opencode>` | which agent CLI implements it |",
    "| `loop:impl-model-<model>` | model for the implement session |",
    "| `loop:impl-effort-<level>` | reasoning effort for the implement session |",
    "| `loop:review-runner-<...>` / `loop:review-model-<...>` / `loop:review-effort-<...>` | the same three axes for the rubric grader |",
    "| `loop:model-<model>` | legacy alias for `loop:impl-model-*` |",
    "",
    "**What the loop will do unattended:** open a PR, fix its own review findings, and squash-merge once CI is green, no blocking (high/critical) review finding remains, and the rubric passes.",
    "",
    "**What it will never do:** merge a PR that touches a schema migration (parked as " +
      `\`${cfg.board.blockedReasons.needsProdMigration}\` for a human), cut a release, or act on anything irreversible beyond merge. Issue text is treated as untrusted data — an issue whose text trips the injection tripwire is blocked, never run.`,
    "",
    "**CI note for repos where a merge triggers a deploy:** the deploy job must NOT share a `cancel-in-progress` concurrency group with CI. Back-to-back merges each cancel the previous run, so intermediate merges' deploys never execute — six merges once left five services running stale code. `cancel-in-progress` is right for tests and catastrophic for anything with side effects.",
    "",
    "Write issues for a competent stranger: state the observable outcome, not the implementation.",
  ].join("\n");

/**
 * Insert or REPLACE the marked block in an existing document. Idempotent by construction: re-running
 * `init` rewrites what is between the markers instead of appending a second copy. A document with a
 * start marker but no end marker is left untouched (returning null) — half-marked content is more
 * likely a hand-edit than a stale block, and clobbering it would eat the user's writing.
 */
export const spliceMarkedBlock = (existing: string, block: string): string | null => {
  const wrapped = `${BLOCK_START}\n${block}\n${BLOCK_END}`;
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  if (start === -1 && end === -1) {
    const sep =
      existing.length === 0 || existing.endsWith("\n\n")
        ? ""
        : existing.endsWith("\n")
          ? "\n"
          : "\n\n";
    return `${existing}${sep}${wrapped}\n`;
  }
  if (start === -1 || end === -1 || end < start) return null;
  return `${existing.slice(0, start)}${wrapped}${existing.slice(end + BLOCK_END.length)}`;
};
