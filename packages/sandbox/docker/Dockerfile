# Rootless-friendly sandbox image for the autonomous loop's headless implement session.
# Minimal: bun (runtime + package manager), git, gh (GitHub CLI), and the Claude Code CLI.
# The loop runs the headless `claude -p` session in here with ONLY the issue worktree (+ its git dir)
# bind-mounted, a per-run repo-scoped GH_TOKEN, and a minimal env allow-list — see buildSandboxArgs /
# resolveSandboxEnv.
#
# Build:  docker build -t hamsterwheel/sandbox:latest packages/sandbox/docker
# Override the tag with SANDBOX_IMAGE. Works under Docker Desktop (macOS) and rootless Docker (Linux CI).
FROM oven/bun:1-debian

# git + gh (GitHub CLI, from GitHub's apt repo) + certs. Kept minimal; single layer.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git gnupg \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (headless `claude -p`), installed globally into bun's bin dir.
RUN bun add -g @anthropic-ai/claude-code
ENV PATH="/root/.bun/bin:${PATH}"

COPY entrypoint.sh /usr/local/bin/sandbox-entrypoint.sh
RUN chmod +x /usr/local/bin/sandbox-entrypoint.sh

# The loop passes an ABSOLUTE workdir (`-w <worktree>`) that is identity-mounted, so no fixed WORKDIR.
ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint.sh"]
