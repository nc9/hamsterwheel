# @hamsterwheel/sandbox

Opt-in OS-isolation boundary for the autonomous loop's **headless implement session**. Without it,
`--execute` is **supervised-only**: the in-process hardening (untrusted-content screening, fenced
prompt, scoped tool allow-list, env scrub) is defense-in-depth, not an isolation boundary — `Edit`/`Write`
reach absolute paths, `Bash(git|gh:*)` can push, and gh/git creds on disk stay readable.

`--sandbox` runs the session inside a **rootless container** with only the issue worktree bind-mounted,
a per-run repo-scoped token, and a minimal env allow-list. Portable: Docker Desktop on macOS, rootless
Docker in Linux CI.

## Build

```bash
docker build -t hamsterwheel/sandbox:latest packages/sandbox/docker
```

Override the tag with `SANDBOX_IMAGE`.

## Run

```bash
export SANDBOX_GITHUB_TOKEN=$(…)      # short-lived, repo-scoped — see "Token minting" below
export SANDBOX_ANTHROPIC_API_KEY=$(…) # model creds for the headless claude session
# … drive the loop with --sandbox …
```

If `SANDBOX_GITHUB_TOKEN` (or `SANDBOX_ANTHROPIC_API_KEY`) is missing the loop **fails closed** with a
clear message — it never falls back to the host's full gh credentials (they aren't mounted, so a
fall-back would silently defeat the boundary).

| env                         | required                                   | maps to (inside container)              |
| --------------------------- | ------------------------------------------ | --------------------------------------- |
| `SANDBOX_GITHUB_TOKEN`      | yes                                        | `GH_TOKEN` (git push + `gh pr create`)  |
| `SANDBOX_ANTHROPIC_API_KEY` | yes                                        | `ANTHROPIC_API_KEY` (claude model auth) |
| `SANDBOX_IMAGE`             | no (default `hamsterwheel/sandbox:latest`) | image tag                               |
| `SANDBOX_NETWORK`           | no (default `bridge`)                      | `docker run --network`                  |

## What crosses the boundary

- **Filesystem:** ONLY the issue worktree **and its git common dir** (the primary repo's `.git`),
  each identity-mounted at its real absolute path. A linked worktree's `.git` is a pointer file into
  `<repo>/.git/worktrees/…` with absolute back-references, so git/commit/push inside the container only
  resolve if both live at their real host paths. Nothing else crosses — no `$HOME`, `~/.ssh`,
  `~/.config/gh`, or cloud cred dirs.
- **Env:** an allow-list only (`GH_TOKEN`, `ANTHROPIC_API_KEY`, `TERM`/`LANG`/`LC_ALL`). Every other
  host var — every secret — is left behind by construction. The token **value** is forwarded by NAME
  (`--env GH_TOKEN`), so it never appears in the `docker` argv / `ps`.

The container entrypoint runs `gh auth setup-git` (so `git push` uses the injected token), then
`bun install` (Linux-native `node_modules` over the mount), then exec's the `claude` session.

## Token minting

Supply a **short-lived, repo-scoped** token — not a broad personal token:

- **CI (recommended):** a GitHub App installation token via
  [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token), scoped to
  `<owner>/<repo>` with `contents:write` + `pull_requests:write`, ~1h TTL.
- **Ad-hoc:** a fine-grained PAT limited to `<owner>/<repo>` with the same two permissions.
- **Supervised only:** `gh auth token` reuses your full user token (broad scope) — acceptable for a
  watched run, **not** for unattended loops.

## Enforced here vs. follow-up

**Enforced by `--sandbox` (tested in `src/sandbox.test.ts`):**

- filesystem scope — only the worktree + git dir mount;
- env allow-list — host secrets excluded by construction;
- fail-closed token — no host-cred fall-back;
- token value kept off argv (forwarded by name, enforced in `buildSandboxArgs`);
- fail-closed on a credential-bearing primary `.git/config` (a set `credential.helper`, a remote URL
  with embedded userinfo/token, or a `url.*.insteadOf` rewrite) that could ride in on the git-dir mount
  or hijack the push — plus a defensive local `credential.helper` unset in the entrypoint.

**Follow-up (honest gaps):**

- **Egress allow-list.** `SANDBOX_NETWORK` defaults to `bridge` (full outbound). A deny-by-default
  policy (allow github + registries, deny arbitrary) needs a dedicated docker network + egress proxy —
  the `SANDBOX_NETWORK` hook is the seam for it, but the policy itself is not yet enforced.
- **Token minting automation.** The loop consumes `SANDBOX_GITHUB_TOKEN`; minting/rotating it per run
  is the caller's responsibility (plumbing only here).
- **Fully hermetic FS.** A tighter alternative to mounting the primary git dir is an in-container fresh
  clone (nothing of the host repo mounted). Deferred.
