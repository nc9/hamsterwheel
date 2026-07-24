#!/usr/bin/env bash
# Sandbox entrypoint. Runs inside the rootless container before the implement session:
#   1. fail closed if the per-run repo-scoped token is missing (defense-in-depth — the loop already
#      fails closed on the host, but never trust a missing GH_TOKEN here either),
#   2. make git authenticate with that token (no host creds are mounted),
#   3. install Linux-native deps over the bind-mounted worktree (the host bun install is skipped),
#   4. exec the passed command (the headless `claude -p …` argv) — exec-form, so no prompt re-quoting.
set -euo pipefail

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "sandbox-entrypoint: GH_TOKEN not set — refusing to run (fail closed)" >&2
  exit 1
fi

# Route git's github.com credentials through gh (which reads GH_TOKEN) so `git push` works with the
# injected per-run token — no ~/.config/gh or ~/.ssh is mounted from the host.
gh auth setup-git --hostname github.com

# Defense-in-depth: drop any repo-LOCAL credential helper that rode in on the mounted .git (the loop
# also fails closed on this host-side) so only gh's helper, backed by the injected GH_TOKEN, is consulted.
git config --local --unset-all credential.helper 2>/dev/null || true

# node_modules must be Linux-native for this image; (re)install over the mounted worktree.
bun install

exec "$@"
