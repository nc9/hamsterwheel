/**
 * @hamsterwheel/config
 *
 * `hamsterwheel.toml` loading + validation. The driver reads NOTHING repo-specific from constants —
 * board field/option names, review bot, migration paths, install command and model policy all come from
 * here. Validation is pure and collects every problem at once; the file IO boundary is a thin wrapper.
 */
export {
  type Config,
  type RoleConfig,
  type StatusNames,
  type BlockedReasonNames,
  ConfigError,
  DEFAULT_ALLOWED_TOOLS,
  parseConfig,
} from "./schema.ts";
export { CONFIG_FILENAME, loadConfig, findConfig } from "./load.ts";
