import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { parse as parseToml } from "smol-toml";

import { ConfigError, type Config, parseConfig } from "./schema.ts";

export const CONFIG_FILENAME = "hamsterwheel.toml";

/**
 * Read + parse + validate the config. Explicit read/parse (rather than `import`ing the TOML) so a syntax
 * error and a missing file get their own actionable message instead of a module-resolution stack.
 *
 * `smol-toml` rather than bun's built-in TOML: node has no built-in TOML parser, and this package is imported by
 * consumers who may not be running bun.
 */
export const loadConfig = async (path: string): Promise<Config> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ConfigError([
      `no ${CONFIG_FILENAME} at ${path} — run \`hamsterwheel init\` to create one`,
    ]);
  }
  let doc: unknown;
  try {
    doc = parseToml(text);
  } catch (e) {
    throw new ConfigError([`${path} is not valid TOML: ${String(e)}`]);
  }
  return parseConfig(doc);
};

/** Walk up from `start` to the filesystem root looking for a config. Returns null when there is none. */
export const findConfig = async (start: string): Promise<string | null> => {
  let dir = isAbsolute(start) ? start : resolve(start);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not here — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

/**
 * Parse + validate config from TOML text already in hand (e.g. content `init` just rendered but has not
 * written). Exists so callers never need their own TOML dependency — the parser stays an implementation
 * detail of this package.
 */
export const parseConfigText = (text: string): Config => {
  let doc: unknown;
  try {
    doc = parseToml(text);
  } catch (e) {
    throw new ConfigError([`not valid TOML: ${String(e)}`]);
  }
  return parseConfig(doc);
};
