/**
 * @hamsterwheel/sandbox
 *
 * The OS-isolated docker sandbox runner for headless agent sessions lands here.
 * Planned surface:
 *   - `buildSandboxArgs`   — assemble the `docker run` argv for one agent session
 *   - `resolveSandboxEnv`  — whitelist + inject only the env the session may see
 *   - a git-config credential scan that refuses to mount secrets into the wheel
 *
 * Nothing below is wired up yet — this is a placeholder so the workspace links.
 */

/**
 * Declarative spec for a single sandboxed agent run. Stub shape: fields will
 * grow (mounts, resource limits, network policy, …) as the runner takes form.
 */
export interface SandboxSpec {
  /** Absolute path to the repo/worktree mounted into the container. */
  readonly workdir: string;
  /** Docker image the agent session runs inside. */
  readonly image: string;
  /** Env var names allowed to cross the boundary into the sandbox. */
  readonly allowedEnv: readonly string[];
}

/** Placeholder marker until the sandbox runner is implemented. */
export const SANDBOX_TODO = true;
