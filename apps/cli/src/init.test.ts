import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectSetupCommand } from "./init.ts";

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "hw-init-"));
  tmp.push(d);
  return d;
};

describe("detectSetupCommand", () => {
  test("empty repo → nothing detected", async () => {
    expect(await detectSetupCommand(dir())).toBeNull();
  });

  test("conductor.json scripts.setup wins over everything", async () => {
    const d = dir();
    await writeFile(join(d, "conductor.json"), JSON.stringify({ scripts: { setup: "pnpm install" } }));
    await writeFile(join(d, "bun.lock"), "");
    expect(await detectSetupCommand(d)).toEqual({
      cmd: "pnpm install",
      source: "conductor.json scripts.setup",
    });
  });

  test("a shell-syntax conductor command is skipped — scripts.setup is argv-exec'd, no shell", async () => {
    const d = dir();
    await writeFile(
      join(d, "conductor.json"),
      JSON.stringify({ scripts: { setup: "pnpm install && pnpm build" } }),
    );
    await writeFile(join(d, "yarn.lock"), "");
    expect(await detectSetupCommand(d)).toEqual({ cmd: "yarn install", source: "yarn.lock" });
  });

  test("a command with control chars is skipped — it would corrupt the rendered TOML string", async () => {
    const d = dir();
    await writeFile(
      join(d, "conductor.json"),
      JSON.stringify({ scripts: { setup: "pnpm install\npnpm build" } }),
    );
    expect(await detectSetupCommand(d)).toBeNull();
  });

  test(".cursor/environment.json install is honoured", async () => {
    const d = dir();
    await mkdir(join(d, ".cursor"));
    await writeFile(join(d, ".cursor/environment.json"), JSON.stringify({ install: "npm ci" }));
    expect(await detectSetupCommand(d)).toEqual({
      cmd: "npm ci",
      source: ".cursor/environment.json install",
    });
  });

  test("a conventional setup script beats the lockfile heuristic", async () => {
    const d = dir();
    await mkdir(join(d, "scripts"));
    await writeFile(join(d, "scripts/setup.sh"), "#!/bin/sh\nbun install\n");
    await writeFile(join(d, "bun.lock"), "");
    expect(await detectSetupCommand(d)).toEqual({
      cmd: "sh scripts/setup.sh",
      source: "scripts/setup.sh",
    });
  });

  test("lockfiles map to their package manager", async () => {
    const cases: [string, string][] = [
      ["bun.lock", "bun install"],
      ["pnpm-lock.yaml", "pnpm install"],
      ["package-lock.json", "npm install"],
      ["uv.lock", "uv sync"],
    ];
    for (const [lock, cmd] of cases) {
      const d = dir();
      await writeFile(join(d, lock), "");
      expect((await detectSetupCommand(d))?.cmd).toBe(cmd);
    }
  });

  test("malformed JSON in a candidate file falls through instead of throwing", async () => {
    const d = dir();
    await writeFile(join(d, "conductor.json"), "{not json");
    await writeFile(join(d, "bun.lockb"), "");
    expect(await detectSetupCommand(d)).toEqual({ cmd: "bun install", source: "bun.lockb" });
  });
});
