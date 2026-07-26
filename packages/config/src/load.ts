import { dirname, isAbsolute, join, resolve } from "node:path";

import { ConfigError, type Config, parseConfig } from "./schema.ts";

export const CONFIG_FILENAME = "hamsterwheel.toml";

/**
 * Read + parse + validate the config. Explicit read/parse (rather than `import`ing the TOML) so a syntax
 * error and a missing file get their own actionable message instead of a module-resolution stack.
 */
export const loadConfig = async (path: string): Promise<Config> => {
  const file = Bun.file(path);
  if (!(await file.exists()))
    throw new ConfigError([
      `no ${CONFIG_FILENAME} at ${path} — run \`hamsterwheel init\` to create one`,
    ]);
  const text = await file.text();
  let doc: unknown;
  try {
    doc = Bun.TOML.parse(text);
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
    if (await Bun.file(candidate).exists()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};
