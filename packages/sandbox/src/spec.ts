// The OS-isolation sandbox spec + argv builder. The in-process hardening a caller might layer on top
// (tool allow-lists, env scrubs, fenced prompts) is defense-in-depth, NOT isolation: Edit/Write reach
// absolute paths, scoped Bash still runs arbitrary code, and on-disk creds stay readable. This path runs
// the session inside a rootless container with ONLY the worktree (+ its git dir) bind-mounted, a per-run
// repo-scoped token, and a minimal env allow-list — portable across macOS (Docker Desktop) and Linux CI
// (rootless Docker).
//
// ENFORCED here: filesystem scope (only the mounts below cross), env ALLOW-list (host secrets left behind
// by construction), and the token value kept off argv (forwarded by NAME). FOLLOW-UP (honest): egress is a
// plain docker network — a deny-by-default allow-list proxy is not yet wired; token MINTING is the caller's job.

// Default sandbox image (override via SANDBOX_IMAGE) and egress network (override via SANDBOX_NETWORK).
// bridge = full outbound; an egress-allow-list network is a follow-up.
export const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? "hamsterwheel/sandbox:latest";
export const SANDBOX_NETWORK = process.env.SANDBOX_NETWORK ?? "bridge";

export type SandboxMount = { hostPath: string; containerPath: string; readOnly?: boolean };
export type SandboxSpec = {
  image: string;
  network: string;
  workdir: string;
  mounts: SandboxMount[]; // the ONLY host paths that cross the boundary
  forwardEnv: string[]; // env var NAMES forwarded into the container (values supplied via processEnv)
  command: string[]; // argv exec'd inside the container
};

// A bare env var NAME (no `=value`). Enforced so buildSandboxArgs can't be coaxed into `--env FOO=secret`.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Build the `docker run` argv (everything after the `docker` binary) for a sandboxed session.
// PURE + SECURITY-CRITICAL (unit-tested): binds EXACTLY spec.mounts and nothing else; forwards env by
// NAME only (`--env FOO`, never `--env FOO=value`) so secret VALUES never land in argv / `ps`; --rm ephemeral.
export const buildSandboxArgs = (spec: SandboxSpec): string[] => {
  const argv = ["run", "--rm", "--network", spec.network, "-w", spec.workdir];
  for (const m of spec.mounts)
    argv.push("-v", `${m.hostPath}:${m.containerPath}${m.readOnly ? ":ro" : ""}`);
  for (const name of spec.forwardEnv) {
    // Reject anything that isn't a bare NAME: a `FOO=value` (or otherwise malformed) entry would put
    // the value on argv — the exact `ps` leak this by-name forwarding exists to prevent.
    if (!ENV_NAME_RE.test(name))
      throw new Error(
        `sandbox: refusing to forward malformed env name "${name}" (must be a bare NAME; a NAME=value would leak the value into argv)`,
      );
    argv.push("--env", name); // name-only → value stays off argv
  }
  argv.push(spec.image, ...spec.command);
  return argv;
};
