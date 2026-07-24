/**
 * @hamsterwheel/sandbox
 *
 * OS-isolated docker sandbox runner for headless agent sessions. The in-process hardening a caller
 * layers on top (tool allow-lists, env scrubs, fenced prompts) is defense-in-depth, NOT isolation —
 * the container is the only real boundary. Only the worktree (+ its git common dir) cross, env crosses
 * by allow-list forwarded by NAME, and tokens FAIL CLOSED (no fall-back to host creds).
 */
export {
  type SandboxMount,
  type SandboxSpec,
  SANDBOX_IMAGE,
  SANDBOX_NETWORK,
  buildSandboxArgs,
} from "./spec.ts";
export { sandboxWorktreeMounts } from "./mounts.ts";
export { scanGitConfigForCredentials } from "./git-config.ts";
export { type SandboxEnv, resolveSandboxEnv } from "./env.ts";
