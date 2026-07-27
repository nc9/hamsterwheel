#!/usr/bin/env bun
/**
 * Build every publishable package to node-targeted ESM.
 *
 * The source is deliberately node-compatible (no `Bun.*`), so this is a bundle+transpile, not a port.
 * Bun is the build tool; the OUTPUT has no bun dependency, which is what lets npm/node consumers install
 * `hamsterwheel` and import `@hamsterwheel/*` without one.
 *
 * The CLI bundles its workspace deps in; the libraries keep theirs external so consumers dedupe normally.
 */
import { rm } from "node:fs/promises";

const LIBS = ["config", "gate", "runners", "sandbox"];
const EXTERNAL = [
  "@hamsterwheel/config",
  "@hamsterwheel/gate",
  "@hamsterwheel/runners",
  "@hamsterwheel/sandbox",
  "smol-toml",
];

const build = async (dir: string, opts: { bundleDeps: boolean }) => {
  await rm(`${dir}/dist`, { recursive: true, force: true });
  const r = await Bun.build({
    entrypoints: [`${dir}/src/index.ts`],
    outdir: `${dir}/dist`,
    target: "node",
    format: "esm",
    // The CLI bundles EVERYTHING (workspace packages and smol-toml alike) so its tarball is
    // self-contained; the libraries keep deps external so consumers dedupe them normally.
    external: opts.bundleDeps ? [] : EXTERNAL,
  });
  if (!r.success) {
    console.error(`✗ ${dir}`);
    for (const m of r.logs) console.error(m);
    process.exit(1);
  }
  // The source shebang is `bun` so `./src/index.ts` is runnable in dev. The SHIPPED bin must be node:
  // the whole point of this build is an artifact that runs without bun installed.
  if (opts.bundleDeps) {
    const out = `${dir}/dist/index.js`;
    const text = await Bun.file(out).text();
    await Bun.write(out, text.replace(/^#!.*\n/, "#!/usr/bin/env node\n"));
  }
  console.log(`✓ ${dir}/dist`);
};

for (const l of LIBS) await build(`packages/${l}`, { bundleDeps: false });
await build("apps/cli", { bundleDeps: true });
