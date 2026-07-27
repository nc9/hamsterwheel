#!/usr/bin/env bun
/**
 * Assert every publishable manifest is installable BY NPM.
 *
 * `workspace:*` is a bun/pnpm protocol. `bun publish` rewrites it to a real version; `npm publish` ships
 * it verbatim, and npm cannot resolve it — the package installs as `ENOVERSIONS: No versions available`,
 * which reads like a registry problem rather than a bad manifest. hamsterwheel@0.1.0 shipped that way and
 * was uninstallable on the registry.
 *
 * Checked against the manifest as it will be PACKED, not the source tree, so it holds whichever publisher
 * is used.
 */
import { rm } from "node:fs/promises";

const PKGS = [
  "packages/config",
  "packages/gate",
  "packages/runners",
  "packages/sandbox",
  "apps/cli",
];
let bad = false;

for (const dir of PKGS) {
  const p = await Bun.file(`${dir}/package.json`).json();
  const deps = { ...p.dependencies, ...p.peerDependencies };
  for (const [name, range] of Object.entries(deps)) {
    if (typeof range === "string" && /^(workspace|link|file):/.test(range)) {
      console.error(`✗ ${p.name}: dependency ${name}="${range}" is not resolvable by npm`);
      bad = true;
    }
  }
  if (!p.license) {
    console.error(`✗ ${p.name}: no license field`);
    bad = true;
  }
  if (p.name.startsWith("@") && p.publishConfig?.access !== "public") {
    console.error(
      `✗ ${p.name}: scoped package without publishConfig.access="public" will publish restricted`,
    );
    bad = true;
  }
}

if (bad) {
  console.error("\nrefusing to publish — fix the manifests above");
  process.exit(1);
}
console.log("✓ manifests are npm-installable");
await rm("/tmp/.hw-check", { recursive: true, force: true });
