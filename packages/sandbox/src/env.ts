// Minimal env ALLOW-list forwarded INTO the sandbox (opposite of a deny-list scrub: only these names
// may cross; every other host var — secrets included — is left behind by construction).
const SANDBOX_PASSTHROUGH = ["TERM", "LANG", "LC_ALL"] as const;
// Vars the HOST `docker` CLI itself needs to find its binary + reach the daemon. These stay on the
// docker PROCESS env only (never in forwardEnv), so they don't enter the container.
const DOCKER_CLI_ENV = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "XDG_RUNTIME_DIR",
] as const;

export type SandboxEnv = {
  forwardNames: string[]; // --env NAMEs forwarded into the container
  containerEnv: Record<string, string>; // the ONLY vars crossing the boundary (name→value)
  processEnv: Record<string, string>; // env for the host docker process (CLI plumbing + container values)
};

// Resolve the env for a sandboxed run. FAIL-CLOSED: a short-lived, repo-scoped token MUST be supplied
// via SANDBOX_GITHUB_TOKEN (mapped to GH_TOKEN inside) — we never fall back to the host's full gh creds
// (they aren't mounted; a silent fall-back would defeat the boundary). The headless agent session also
// needs model auth (host ~/.claude isn't mounted): SANDBOX_ANTHROPIC_API_KEY → ANTHROPIC_API_KEY.
export const resolveSandboxEnv = (env: Record<string, string | undefined>): SandboxEnv => {
  const ghToken = env.SANDBOX_GITHUB_TOKEN?.trim();
  if (!ghToken)
    throw new Error(
      "--sandbox: SANDBOX_GITHUB_TOKEN is required (a short-lived, repo-scoped GitHub token minted per run). " +
        "Refusing to run — the host gh/git credentials are NOT mounted into the sandbox and must not be used as a fall-back.",
    );
  const anthropicKey = env.SANDBOX_ANTHROPIC_API_KEY?.trim();
  if (!anthropicKey)
    throw new Error(
      "--sandbox: SANDBOX_ANTHROPIC_API_KEY is required (model credentials for the headless agent session; the host ~/.claude is not mounted).",
    );
  const containerEnv: Record<string, string> = {
    GH_TOKEN: ghToken,
    ANTHROPIC_API_KEY: anthropicKey,
  };
  for (const name of SANDBOX_PASSTHROUGH) {
    const v = env[name];
    if (v !== undefined) containerEnv[name] = v;
  }
  const processEnv: Record<string, string> = { ...containerEnv };
  for (const name of DOCKER_CLI_ENV) {
    const v = env[name];
    if (v !== undefined) processEnv[name] = v;
  }
  return { forwardNames: Object.keys(containerEnv), containerEnv, processEnv };
};
