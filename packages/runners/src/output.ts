import type { RunnerName } from "./runner.ts";

/**
 * The common shape every runner's output is normalized into, so `classifyImplement` and
 * `parseRubricVerdict` (@hamsterwheel/gate) work unchanged across runners.
 * `lastMessage` is the agent's final assistant message — the thing carrying the output contract
 * (a PR url / the already-resolved signal / the rubric JSON).
 */
export type RunnerOutput = { lastMessage: string; exitCode: number; raw: string };

/** Last non-empty line — the universal fallback when the structured envelope can't be understood. */
const lastLine = (text: string): string =>
  text.trim().split("\n").filter(Boolean).at(-1)?.trim() ?? "";

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

// Pull the first string out of the fields these CLIs actually use for the final message. Kept
// permissive on purpose: the envelope shapes are version-dependent, and a missing field must degrade to
// the raw-text fallback rather than throwing inside the loop's happy path.
const MESSAGE_KEYS = ["result", "text", "message", "content", "last_message", "response"] as const;
const pickMessage = (obj: Record<string, unknown>): string | undefined => {
  for (const k of MESSAGE_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
    // opencode nests the assistant text a level down (`{message:{content:"…"}}`).
    const nested = asRecord(v);
    if (nested) {
      const inner = pickMessage(nested);
      if (inner) return inner;
    }
  }
  return undefined;
};

/**
 * Normalize a finished session's stdout into `{ lastMessage, exitCode, raw }`.
 *
 * NEVER throws: a runner that changed its envelope, printed a stray banner, or died mid-JSON must fall
 * back to the raw last line, not take the loop down. A wrong-but-plausible lastMessage is handled
 * downstream — classifyImplement treats a missing PR url on a dirty tree as a failure, which is the
 * safe direction.
 */
export const parseRunnerOutput = (
  runner: RunnerName,
  o: { stdout: string; exitCode: number },
): RunnerOutput => {
  const raw = o.stdout;
  const base = { exitCode: o.exitCode, raw };

  // codex --json streams JSONL events; the final agent message is the last event carrying text.
  if (runner === "codex") {
    for (const line of raw.trim().split("\n").toReversed()) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const obj = asRecord(JSON.parse(t));
        const msg =
          obj &&
          (pickMessage(obj) ?? (asRecord(obj.msg) ? pickMessage(asRecord(obj.msg)!) : undefined));
        if (msg) return { ...base, lastMessage: msg.trim() };
      } catch {
        /* not an event line — keep scanning back */
      }
    }
    return { ...base, lastMessage: lastLine(raw) };
  }

  // claude --output-format json and opencode --format json both emit one JSON document.
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    const obj = asRecord(parsed);
    if (obj) {
      const msg = pickMessage(obj);
      if (msg) return { ...base, lastMessage: msg.trim() };
    }
    // An array envelope (opencode message parts): take the last stringy entry.
    if (Array.isArray(parsed)) {
      for (const entry of parsed.toReversed()) {
        const rec = asRecord(entry);
        const msg = rec ? pickMessage(rec) : typeof entry === "string" ? entry : undefined;
        if (msg) return { ...base, lastMessage: msg.trim() };
      }
    }
  } catch {
    /* not JSON (banner, plain text, crash) — fall through to the raw last line */
  }
  return { ...base, lastMessage: lastLine(raw) };
};

/**
 * The last line of the final message — what the implement output contract is parsed from.
 * Agents often close with prose ABOVE the contract line, so the contract is the last line of the
 * message, not the whole message.
 */
export const contractLine = (out: RunnerOutput): string => lastLine(out.lastMessage);
