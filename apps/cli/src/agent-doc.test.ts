import { parseConfig } from "@hamsterwheel/config";
import { describe, expect, test } from "bun:test";

import { BLOCK_END, BLOCK_START, buildAgentDoc, spliceMarkedBlock } from "./agent-doc.ts";

const cfg = parseConfig(
  Bun.TOML.parse(`
repo = "acme/backend"
criteria_heading = "Done when"
[[human]]
name = "prod-migration"
paths = "(^|/)drizzle/"
[project]
number = 1
[board.status]
ready = "Todo"
`),
  { home: "/home/ci" },
);

describe("buildAgentDoc", () => {
  test("documents the contract using the CONFIGURED vocabulary", () => {
    const doc = buildAgentDoc(cfg);
    expect(doc).toContain("## Done when");
    expect(doc).toContain("`Todo`");
    expect(doc).toContain("acme/backend");
    expect(doc).toContain("Depends on #123");
    expect(doc).toContain("loop:impl-runner-");
    expect(doc).toContain("loop:model-");
    // The hard human gates must be stated, not implied.
    expect(doc).toContain("schema migration");
    expect(doc).toContain("untrusted");
  });
});

describe("spliceMarkedBlock", () => {
  test("appends with markers when the document has none", () => {
    const out = spliceMarkedBlock("# Guide\n\nSome rules.\n", "BLOCK")!;
    expect(out).toContain("# Guide");
    expect(out).toContain(`${BLOCK_START}\nBLOCK\n${BLOCK_END}`);
  });

  test("re-running REPLACES the block instead of duplicating it", () => {
    const first = spliceMarkedBlock("# Guide\n", "V1")!;
    const second = spliceMarkedBlock(first, "V2")!;
    expect(second.split(BLOCK_START)).toHaveLength(2);
    expect(second).toContain("V2");
    expect(second).not.toContain("V1");
    expect(second).toContain("# Guide");
  });

  test("content after the end marker survives a replace", () => {
    const doc = `A\n${BLOCK_START}\nold\n${BLOCK_END}\nZ\n`;
    const out = spliceMarkedBlock(doc, "new")!;
    expect(out.startsWith("A\n")).toBe(true);
    expect(out.endsWith("\nZ\n")).toBe(true);
    expect(out).toContain("new");
  });

  test("a half-marked document is refused rather than clobbered", () => {
    expect(spliceMarkedBlock(`A\n${BLOCK_START}\nhand-written\n`, "X")).toBeNull();
    expect(spliceMarkedBlock(`A\n${BLOCK_END}\n${BLOCK_START}\n`, "X")).toBeNull();
  });

  test("an empty document gets just the block", () => {
    expect(spliceMarkedBlock("", "X")).toBe(`${BLOCK_START}\nX\n${BLOCK_END}\n`);
  });
});
